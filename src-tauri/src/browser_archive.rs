//! Retained export of legacy WebView bytes, including unknown plugin values and
//! unopened accounts' signing keys. Only ciphertext is published to the root.
//! The coordinator seals an origin before launching any isolated worker.
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use chacha20poly1305::ChaCha20Poly1305;
use keyring_core::Entry;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

use crate::error::{AppError, AppResult};
use crate::storage_locks::RootLock;

const FILE: &str = "legacy-browser-archive.json";
const SEAL_PREFIX: &str = ".browser-origin-sealed-";
const MAX_BYTES: usize = 32 * 1024 * 1024;

pub type Values = BTreeMap<String, String>;

// No Debug implementations: these values may contain private credentials.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub origin: String,
    pub vault_id: String,
    pub values: Values,
    checksum: String,
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        for value in self.values.values_mut() {
            value.zeroize();
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Archive {
    version: u32,
    revision: u64,
    captures: BTreeMap<String, Snapshot>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u32,
    nonce: String,
    ciphertext: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Seal {
    version: u32,
    origin: String,
    checksum: String,
}

#[derive(Serialize)]
pub struct Status {
    pub revision: u64,
    pub checksum: String,
    pub sealed: bool,
}

fn invalid() -> AppError {
    AppError::InvalidArg(
        "legacy browser export corrupt or unavailable; original store retained".into(),
    )
}

fn valid_origin(origin: &str) -> bool {
    if matches!(
        origin,
        "http://tauri.localhost" | "https://tauri.localhost" | "tauri://localhost"
    ) {
        return true;
    }
    // The configured Vite port and loopback hostname can differ between dev
    // sessions. The export caller is separately pinned to the configured origin.
    let Ok(url) = tauri::Url::parse(origin) else {
        return false;
    };
    url.scheme() == "http"
        && url.port().is_some_and(|port| port != 0)
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
        && url.origin().ascii_serialization() == origin
        && url.host_str().is_some_and(|host| {
            host == "localhost"
                || host == "[::1]"
                || host
                    .parse::<std::net::Ipv4Addr>()
                    .is_ok_and(|address| address.is_loopback())
        })
}

fn checksum(origin: &str, vault_id: &str, values: &Values) -> AppResult<String> {
    if !valid_origin(origin) || vault_id.is_empty() || vault_id.len() > 128 || values.len() > 4096 {
        return Err(invalid());
    }
    let mut size = 0usize;
    let mut hash = Sha256::new();
    for text in [origin, vault_id].into_iter().chain(
        values
            .iter()
            .flat_map(|(key, value)| [key.as_str(), value.as_str()]),
    ) {
        size = size.checked_add(text.len()).ok_or_else(invalid)?;
        if size > MAX_BYTES {
            return Err(invalid());
        }
        hash.update((text.len() as u64).to_be_bytes());
        hash.update(text.as_bytes());
    }
    if values.keys().any(|key| key.is_empty() || key.len() > 4096) {
        return Err(invalid());
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn seal_path(root: &Path, origin: &str) -> std::path::PathBuf {
    root.join(format!(
        "{SEAL_PREFIX}{:x}.json",
        Sha256::digest(origin.as_bytes())
    ))
}

fn seals(root: &Path) -> AppResult<BTreeMap<String, String>> {
    let mut seals = BTreeMap::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_name().to_string_lossy().starts_with(SEAL_PREFIX) {
            continue;
        }
        let bytes = fs::read(entry.path())?;
        if bytes.len() > 4096 {
            return Err(invalid());
        }
        let seal: Seal = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if seal.version != 1
            || !valid_origin(&seal.origin)
            || seal.checksum.len() != 64
            || !seal
                .checksum
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || entry.path() != seal_path(root, &seal.origin)
        {
            return Err(invalid());
        }
        seals.insert(seal.origin, seal.checksum);
    }
    Ok(seals)
}

fn validate(archive: &Archive, seals: &BTreeMap<String, String>) -> AppResult<()> {
    if archive.version != 1 || archive.captures.len() > 4 {
        return Err(invalid());
    }
    for (origin, snapshot) in &archive.captures {
        if origin != &snapshot.origin
            || snapshot.checksum != checksum(origin, &snapshot.vault_id, &snapshot.values)?
        {
            return Err(invalid());
        }
    }
    for (origin, checksum) in seals {
        if !archive
            .captures
            .get(origin)
            .is_some_and(|snapshot| &snapshot.checksum == checksum)
        {
            return Err(invalid());
        }
    }
    Ok(())
}

fn encrypt(archive: &Archive, key: &[u8; 32], aad: &[u8]) -> AppResult<Vec<u8>> {
    validate(archive, &BTreeMap::new())?;
    let plain = Zeroizing::new(serde_json::to_vec(archive).map_err(|_| invalid())?);
    if plain.len() > MAX_BYTES {
        return Err(invalid());
    }
    let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = ChaCha20Poly1305::new(key.into())
        .encrypt(&nonce, Payload { msg: &plain, aad })
        .map_err(|_| invalid())?;
    serde_json::to_vec(&Envelope {
        version: 1,
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })
    .map_err(|_| invalid())
}

fn decrypt(
    raw: &[u8],
    key: &[u8; 32],
    aad: &[u8],
    seals: &BTreeMap<String, String>,
) -> AppResult<Archive> {
    if raw.len() > MAX_BYTES * 2 {
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
    if plain.len() > MAX_BYTES {
        return Err(invalid());
    }
    let archive: Archive = serde_json::from_slice(&plain).map_err(|_| invalid())?;
    validate(&archive, seals)?;
    Ok(archive)
}

fn master(entry: &Entry, create: bool) -> AppResult<Zeroizing<[u8; 32]>> {
    match entry.get_password() {
        Ok(value) => {
            let value = Zeroizing::new(value);
            let bytes = Zeroizing::new(STANDARD.decode(value.as_bytes()).map_err(|_| invalid())?);
            Ok(Zeroizing::new(
                bytes.as_slice().try_into().map_err(|_| invalid())?,
            ))
        }
        Err(keyring_core::Error::NoEntry) if create => {
            let key: [u8; 32] = ChaCha20Poly1305::generate_key(&mut OsRng).into();
            let key = Zeroizing::new(key);
            let encoded = Zeroizing::new(STANDARD.encode(key.as_slice()));
            entry.set_password(&encoded).map_err(|_| invalid())?;
            Ok(key)
        }
        Err(_) => Err(invalid()),
    }
}

fn identity(root: &Path, service: &str) -> AppResult<(Entry, Vec<u8>)> {
    let root = fs::canonicalize(root)?;
    let hash = format!("{:x}", Sha256::digest(root.as_os_str().as_encoded_bytes()));
    let entry =
        Entry::new(service, &format!("browser-migration-key::{hash}")).map_err(|_| invalid())?;
    let aad = format!("mindstream-browser-export-v1\0{service}\0{hash}").into_bytes();
    Ok((entry, aad))
}

struct Loaded {
    archive: Archive,
    key: Zeroizing<[u8; 32]>,
    seals: BTreeMap<String, String>,
}

fn read(root: &Path, entry: &Entry, aad: &[u8]) -> AppResult<Loaded> {
    let path = root.join(FILE);
    let seals = seals(root)?;
    let previous = root.join(format!("{FILE}.previous"));
    let existing = path.try_exists()? || previous.try_exists()?;
    if !existing && !seals.is_empty() {
        return Err(invalid());
    }
    // Write the key first. A crash before export reuses it. Existing ciphertext
    // or seal receipts must never cause a missing key to be regenerated.
    let key = master(entry, !existing)?;
    crate::root_documents::recover(
        &path,
        |raw| decrypt(raw, &key, aad, &seals).map(|_| ()),
        |raw| decrypt(raw, &key, aad, &seals).map(|_| ()),
    )?;
    let archive = if path.try_exists()? {
        decrypt(&fs::read(&path)?, &key, aad, &seals)?
    } else {
        Archive {
            version: 1,
            revision: 0,
            captures: BTreeMap::new(),
        }
    };
    Ok(Loaded {
        archive,
        key,
        seals,
    })
}

fn capture_file(
    root: &Path,
    entry: &Entry,
    aad: &[u8],
    origin: &str,
    vault_id: &str,
    values: Values,
) -> AppResult<Status> {
    // Wrap incoming private strings before any operation that can return early.
    let mut incoming = Snapshot {
        origin: origin.into(),
        vault_id: vault_id.into(),
        values,
        checksum: String::new(),
    };
    incoming.checksum = checksum(origin, vault_id, &incoming.values)?;
    let _lock = RootLock::acquire(root)?;
    let Loaded {
        mut archive,
        key,
        seals,
    } = read(root, entry, aad)?;
    if let Some(existing) = archive.captures.get(origin) {
        if existing.vault_id != vault_id {
            return Err(invalid());
        }
        if existing.checksum == incoming.checksum {
            return Ok(Status {
                revision: archive.revision,
                checksum: existing.checksum.clone(),
                sealed: seals.contains_key(origin),
            });
        }
    }
    if seals.contains_key(origin) {
        return Err(invalid());
    }
    let digest = incoming.checksum.clone();
    archive.captures.insert(origin.into(), incoming);
    archive.revision = archive.revision.checked_add(1).ok_or_else(invalid)?;
    let raw = encrypt(&archive, &key, aad)?;
    crate::root_documents::write(&root.join(FILE), &raw, |raw| {
        decrypt(raw, &key, aad, &seals).map(|_| ())
    })?;
    Ok(Status {
        revision: archive.revision,
        checksum: digest,
        sealed: false,
    })
}

pub fn capture(
    root: &Path,
    service: &str,
    origin: &str,
    vault_id: &str,
    values: Values,
) -> AppResult<Status> {
    let (entry, aad) = identity(root, service)?;
    capture_file(root, &entry, &aad, origin, vault_id, values)
}

fn seal_file(
    root: &Path,
    entry: &Entry,
    aad: &[u8],
    origin: &str,
    expected_checksum: &str,
) -> AppResult<Status> {
    let _lock = RootLock::acquire(root)?;
    if !root.join(FILE).try_exists()? && !root.join(format!("{FILE}.previous")).try_exists()? {
        return Err(invalid());
    }
    let Loaded { archive, seals, .. } = read(root, entry, aad)?;
    let snapshot = archive.captures.get(origin).ok_or_else(invalid)?;
    if snapshot.checksum != expected_checksum {
        return Err(invalid());
    }
    if !seals.contains_key(origin) {
        let raw = serde_json::to_vec(&Seal {
            version: 1,
            origin: origin.into(),
            checksum: snapshot.checksum.clone(),
        })
        .map_err(|_| invalid())?;
        // Immutable receipt published only after verifying the saved ciphertext.
        // Retrying this step after a crash is safe and cannot re-export a store.
        crate::atomic_file::write(&seal_path(root, origin), &raw)?;
    }
    Ok(Status {
        revision: archive.revision,
        checksum: snapshot.checksum.clone(),
        sealed: true,
    })
}

pub fn seal(
    root: &Path,
    service: &str,
    origin: &str,
    expected_checksum: &str,
) -> AppResult<Status> {
    let (entry, aad) = identity(root, service)?;
    seal_file(root, &entry, &aad, origin, expected_checksum)
}

pub fn load(root: &Path, service: &str, origin: &str) -> AppResult<Option<Snapshot>> {
    let (entry, aad) = identity(root, service)?;
    load_file(root, &entry, &aad, origin)
}

/// Finish a capture interrupted between ciphertext publication and sealing.
/// The saved capture wins; reopening/exporting a browser store cannot replace
/// bytes already captured before a crash. No key is created for an empty root.
pub fn resume_export(root: &Path, service: &str, origin: &str) -> AppResult<bool> {
    let (entry, aad) = identity(root, service)?;
    resume_export_file(root, &entry, &aad, origin)
}

fn resume_export_file(root: &Path, entry: &Entry, aad: &[u8], origin: &str) -> AppResult<bool> {
    if !valid_origin(origin) {
        return Err(invalid());
    }
    let _lock = RootLock::acquire(root)?;
    if !root.join(FILE).try_exists()? && !root.join(format!("{FILE}.previous")).try_exists()? {
        if !seals(root)?.is_empty() {
            return Err(invalid());
        }
        return Ok(false);
    }
    let Loaded { archive, seals, .. } = read(root, entry, aad)?;
    let Some(snapshot) = archive.captures.get(origin) else {
        return Ok(false);
    };
    if !seals.contains_key(origin) {
        let raw = serde_json::to_vec(&Seal {
            version: 1,
            origin: origin.into(),
            checksum: snapshot.checksum.clone(),
        })
        .map_err(|_| invalid())?;
        crate::atomic_file::write(&seal_path(root, origin), &raw)?;
    }
    Ok(true)
}

fn load_file(root: &Path, entry: &Entry, aad: &[u8], origin: &str) -> AppResult<Option<Snapshot>> {
    let _lock = RootLock::acquire(root)?;
    if !root.join(FILE).try_exists()? && !root.join(format!("{FILE}.previous")).try_exists()? {
        if !seals(root)?.is_empty() {
            return Err(invalid());
        }
        return Ok(None);
    }
    let Loaded {
        mut archive, seals, ..
    } = read(root, entry, aad)?;
    if archive.captures.contains_key(origin) && !seals.contains_key(origin) {
        return Err(invalid());
    }
    Ok(archive.captures.remove(origin))
}

#[cfg(test)]
mod tests;
