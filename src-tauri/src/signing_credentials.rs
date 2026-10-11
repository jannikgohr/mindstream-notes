//! Vault-owned collaboration identities, encrypted with a vault key in the OS
//! keystore. Browser-store migration must preserve these keys, never regenerate
//! them because the keystore is unavailable or the credential file is corrupt.
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use chacha20poly1305::ChaCha20Poly1305;
use keyring_core::Entry;
use p256::pkcs8::{DecodePrivateKey, DecodePublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use zeroize::{Zeroize, Zeroizing};

use crate::error::{AppError, AppResult, CommandResult};

const FILE_NAME: &str = "collab-signing-credentials.json";
// Main and note WebViews can ask at the same time. Vault lifetime ownership
// excludes other processes; this mutex serializes get/create within the worker.
static ACCESS: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Material {
    username: String,
    public_key_b64: String,
    private_key_pkcs8_b64: String,
}

impl Drop for Material {
    fn drop(&mut self) {
        self.private_key_pkcs8_b64.zeroize();
    }
}

impl Material {
    fn validate(&self) -> AppResult<()> {
        let invalid = || AppError::InvalidArg("invalid collaboration signing key material".into());
        if self.username.is_empty()
            || self.username.len() > 512
            || self.public_key_b64.len() > 1024
            || self.private_key_pkcs8_b64.len() > 1024
        {
            return Err(invalid());
        }
        let public = STANDARD
            .decode(&self.public_key_b64)
            .map_err(|_| invalid())?;
        let private = Zeroizing::new(
            STANDARD
                .decode(&self.private_key_pkcs8_b64)
                .map_err(|_| invalid())?,
        );
        let public = p256::PublicKey::from_public_key_der(&public).map_err(|_| invalid())?;
        let private = p256::SecretKey::from_pkcs8_der(&private).map_err(|_| invalid())?;
        if public.to_sec1_bytes() != private.public_key().to_sec1_bytes() {
            return Err(invalid());
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u32,
    nonce: String,
    ciphertext: String,
}

type Materials = BTreeMap<String, Material>;

pub(crate) fn keyring_account(profile_id: &str) -> String {
    format!("collab-signing-storage-key::{profile_id}")
}

fn account_id(server: &str, username: &str) -> String {
    let mut hash = Sha256::new();
    hash.update((server.len() as u64).to_le_bytes());
    hash.update(server.as_bytes());
    hash.update(username.as_bytes());
    format!("{:x}", hash.finalize())
}

fn associated_data(service: &str, profile_id: &str) -> Vec<u8> {
    format!("mindstream-collab-signing-v1\0{service}\0{profile_id}").into_bytes()
}

fn validate_materials(materials: &Materials) -> AppResult<()> {
    if materials.len() > 128 {
        return Err(AppError::InvalidArg(
            "too many stored collaboration identities".into(),
        ));
    }
    for (id, material) in materials {
        if id.len() != 64 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(AppError::InvalidArg(
                "corrupt collaboration identity index".into(),
            ));
        }
        material.validate()?;
    }
    Ok(())
}

fn encrypt(materials: &Materials, key: &[u8; 32], aad: &[u8]) -> AppResult<Vec<u8>> {
    validate_materials(materials)?;
    let plain = Zeroizing::new(
        serde_json::to_vec(materials)
            .map_err(|_| AppError::InvalidArg("serialize collaboration credentials".into()))?,
    );
    let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = ChaCha20Poly1305::new(key.into())
        .encrypt(&nonce, Payload { msg: &plain, aad })
        .map_err(|_| AppError::InvalidArg("encrypt collaboration credentials".into()))?;
    serde_json::to_vec(&Envelope {
        version: 1,
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })
    .map_err(|_| AppError::InvalidArg("serialize encrypted collaboration credentials".into()))
}

fn decrypt(raw: &[u8], key: &[u8; 32], aad: &[u8]) -> AppResult<Materials> {
    let invalid = || {
        AppError::InvalidArg(
            "collaboration credentials corrupt or unavailable; recovery required".into(),
        )
    };
    if raw.len() > 512 * 1024 {
        return Err(invalid());
    }
    let envelope: Envelope = serde_json::from_slice(raw).map_err(|_| invalid())?;
    if envelope.version != 1 {
        return Err(invalid());
    }
    let nonce = STANDARD.decode(envelope.nonce).map_err(|_| invalid())?;
    if nonce.len() != 12 {
        return Err(invalid());
    }
    let ciphertext = STANDARD
        .decode(envelope.ciphertext)
        .map_err(|_| invalid())?;
    let plain = Zeroizing::new(
        ChaCha20Poly1305::new(key.into())
            .decrypt(
                nonce.as_slice().into(),
                Payload {
                    msg: &ciphertext,
                    aad,
                },
            )
            .map_err(|_| invalid())?,
    );
    let materials = serde_json::from_slice(&plain).map_err(|_| invalid())?;
    validate_materials(&materials)?;
    Ok(materials)
}

fn master_key(entry: &Entry, create: bool) -> AppResult<Zeroizing<[u8; 32]>> {
    let unavailable = || {
        AppError::InvalidArg("vault signing keystore unavailable; no keys were regenerated".into())
    };
    match entry.get_password() {
        Ok(encoded) => {
            let encoded = Zeroizing::new(encoded);
            let bytes = Zeroizing::new(
                STANDARD
                    .decode(encoded.as_bytes())
                    .map_err(|_| unavailable())?,
            );
            Ok(Zeroizing::new(
                bytes.as_slice().try_into().map_err(|_| unavailable())?,
            ))
        }
        Err(keyring_core::Error::NoEntry) if create => {
            let key: [u8; 32] = ChaCha20Poly1305::generate_key(&mut OsRng).into();
            let key = Zeroizing::new(key);
            let encoded = Zeroizing::new(STANDARD.encode(key.as_slice()));
            entry.set_password(&encoded).map_err(|_| unavailable())?;
            Ok(key)
        }
        Err(_) => Err(unavailable()),
    }
}

fn read_materials(path: &Path, entry: &Entry, aad: &[u8]) -> AppResult<Materials> {
    match fs::read(path) {
        Ok(raw) => {
            let key = master_key(entry, false)?;
            decrypt(&raw, &key, aad)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Materials::new()),
        Err(err) => Err(err.into()),
    }
}

fn access(
    app: &AppHandle,
    server_url: &str,
    username: &str,
    incoming: Option<Material>,
) -> AppResult<Option<Material>> {
    let session = crate::auth::read_session_info(app)?.ok_or_else(|| {
        AppError::InvalidArg("signing credentials require a vault account".into())
    })?;
    if session.server_url != server_url || session.username != username {
        return Err(AppError::InvalidArg(
            "vault account changed while loading signing credentials".into(),
        ));
    }
    let environment = app.state::<crate::environment::Environment>();
    let profile = app.state::<crate::paths::ActiveProfile>();
    let aad = associated_data(&environment.credential_service, &profile.id);
    let entry = Entry::new(
        &environment.credential_service,
        &keyring_account(&profile.id),
    )
    .map_err(|_| AppError::InvalidArg("vault signing keystore unavailable".into()))?;
    let path = profile.dir.join(FILE_NAME);
    let source = app.try_state::<crate::browser_migration::Source>();
    let raw = source
        .as_ref()
        .and_then(|source| source.signing_raw(server_url, username));
    access_file_with_legacy(&path, &entry, &aad, server_url, username, incoming, raw)
}

#[cfg(test)]
fn access_file(
    path: &Path,
    entry: &Entry,
    aad: &[u8],
    server_url: &str,
    username: &str,
    incoming: Option<Material>,
) -> AppResult<Option<Material>> {
    access_file_with_legacy(path, entry, aad, server_url, username, incoming, None)
}

fn access_file_with_legacy(
    path: &Path,
    entry: &Entry,
    aad: &[u8],
    server_url: &str,
    username: &str,
    incoming: Option<Material>,
    legacy_raw: Option<&str>,
) -> AppResult<Option<Material>> {
    let _guard = ACCESS
        .lock()
        .map_err(|_| AppError::InvalidArg("signing credential state poisoned".into()))?;
    let mut materials = read_materials(path, entry, aad)?;
    let id = account_id(server_url, username);
    if let Some(existing) = materials.get(&id) {
        if existing.username != username {
            return Err(AppError::InvalidArg(
                "stored signing account mismatch".into(),
            ));
        }
        return Ok(Some(existing.clone()));
    }
    // Check stored material first: stale/corrupt retained browser bytes cannot
    // overwrite or block an identity already imported into this vault.
    let incoming = if let Some(raw) = legacy_raw {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct LegacyMaterial {
            public_key_b64: String,
            private_key_pkcs8_b64: String,
        }
        impl Drop for LegacyMaterial {
            fn drop(&mut self) {
                self.private_key_pkcs8_b64.zeroize();
            }
        }
        let invalid = || AppError::InvalidArg("retained signing key needs recovery".into());
        if raw.len() > 16384 {
            return Err(invalid());
        }
        let legacy: LegacyMaterial = serde_json::from_str(raw).map_err(|_| invalid())?;
        Some(Material {
            username: username.into(),
            public_key_b64: legacy.public_key_b64.clone(),
            private_key_pkcs8_b64: legacy.private_key_pkcs8_b64.clone(),
        })
    } else {
        incoming
    };
    let Some(incoming) = incoming else {
        return Ok(None);
    };
    incoming.validate()?;
    if incoming.username != username {
        return Err(AppError::InvalidArg(
            "imported signing account mismatch".into(),
        ));
    }
    let result = incoming.clone();
    materials.insert(id, incoming);
    let key = master_key(entry, !path.try_exists()?)?;
    crate::atomic_file::write(path, &encrypt(&materials, &key, aad)?)?;
    Ok(Some(result))
}

#[tauri::command]
pub async fn get_vault_collab_signing_material(
    app: AppHandle,
    server_url: String,
    username: String,
) -> CommandResult<Option<Material>> {
    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let _job = job;
        access(&app, &server_url, &username, None)
    })
    .await
    .map_err(|_| AppError::InvalidArg("load signing credentials task failed".into()))??)
}

#[tauri::command]
pub async fn store_vault_collab_signing_material(
    app: AppHandle,
    server_url: String,
    material: Material,
) -> CommandResult<Material> {
    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let _job = job;
        let username = material.username.clone();
        access(&app, &server_url, &username, Some(material))?
            .ok_or_else(|| AppError::InvalidArg("signing credentials were not stored".into()))
    })
    .await
    .map_err(|_| AppError::InvalidArg("store signing credentials task failed".into()))??)
}

#[cfg(test)]
mod tests;
