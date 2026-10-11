//! Discovery records never grant ownership. Reconciliation removes stale
//! records only while holding the physical vault's OS lease; live records need
//! an authenticated identity reply before the coordinator can adopt a worker.
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::LazyLock;
use uuid::Uuid;

use crate::coordinator_ipc::Endpoint;
use crate::error::{AppError, AppResult};
use crate::storage_locks::{RootLock, VaultLock};

// No Debug: registration includes an endpoint credential.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registration {
    pub version: u32,
    pub root: PathBuf,
    pub vault_id: String,
    pub directory: PathBuf,
    pub launch_id: Uuid,
    pub endpoint: Endpoint,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    pub root: PathBuf,
    pub vault_id: String,
    pub directory: PathBuf,
    pub launch_id: Uuid,
    pub ready: bool,
    #[serde(default)]
    pub window: Option<String>,
    #[serde(default)]
    pub contract: Option<RuntimeContract>,
}

/// Bump these versions before incompatible IPC or shared-document changes.
/// Hashing the bundled settings schema also catches accidental ownership edits.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeContract {
    pub protocol: u32,
    pub storage: u32,
    pub settings_schema: String,
}

impl RuntimeContract {
    pub fn current() -> &'static Self {
        static CONTRACT: LazyLock<RuntimeContract> = LazyLock::new(|| RuntimeContract {
            protocol: 4,
            storage: 2,
            settings_schema: format!(
                "{:x}",
                Sha256::new()
                    .chain_update(include_bytes!("../../src/lib/settings/schema.json"))
                    .chain_update(include_bytes!(
                        "../../src/lib/hotkeys/global-shortcuts.json"
                    ))
                    .finalize()
            ),
        });
        &CONTRACT
    }
}

impl Identity {
    pub fn require_compatible(&self) -> AppResult<()> {
        if self.contract.as_ref() != Some(RuntimeContract::current()) {
            return Err(AppError::InvalidArg(
                "an open vault uses an incompatible app build; close its app windows before restarting this build".into(),
            ));
        }
        Ok(())
    }
}

pub enum Recovery {
    Vacant,
    Held(Registration),
}

fn invalid() -> AppError {
    AppError::InvalidArg("vault worker discovery is unavailable; ownership retained".into())
}

fn path(root: &Path, id: &str) -> AppResult<PathBuf> {
    if !crate::profiles::valid_id(id) {
        return Err(invalid());
    }
    Ok(root.join("worker-registrations").join(format!("{id}.json")))
}

impl Registration {
    pub fn new(
        root: &Path,
        id: &str,
        owner: &VaultLock,
        launch_id: Uuid,
        endpoint: Endpoint,
    ) -> AppResult<Self> {
        let value = Self {
            version: 1,
            root: fs::canonicalize(root)?,
            vault_id: id.into(),
            directory: owner.directory.clone(),
            launch_id,
            endpoint,
        };
        value.validate(root, id, &owner.directory)?;
        Ok(value)
    }

    fn validate(&self, root: &Path, id: &str, directory: &Path) -> AppResult<()> {
        if self.version != 1
            || self.launch_id.is_nil()
            || self.vault_id != id
            || !crate::profiles::valid_id(id)
            || self.root != fs::canonicalize(root)?
            || self.directory != fs::canonicalize(directory)?
            || self.directory != fs::canonicalize(crate::profiles::profile_dir(root, id))?
        {
            return Err(invalid());
        }
        self.endpoint.validate()?;
        Ok(())
    }

    pub fn identity(&self, ready: bool) -> Identity {
        Identity {
            root: self.root.clone(),
            vault_id: self.vault_id.clone(),
            directory: self.directory.clone(),
            launch_id: self.launch_id,
            ready,
            window: None,
            contract: Some(RuntimeContract::current().clone()),
        }
    }

    pub fn matches(&self, identity: &Identity) -> bool {
        self.root == identity.root
            && self.vault_id == identity.vault_id
            && self.directory == identity.directory
            && self.launch_id == identity.launch_id
    }

    pub fn identify(&self) -> AppResult<Identity> {
        let reply = self
            .endpoint
            .retry_call(&crate::coordinator_ipc::Request {
                id: Uuid::new_v4(),
                payload: serde_json::json!({"command":"identify", "launch_id":self.launch_id}),
            })?
            .map_err(|_| invalid())?;
        let identity: Identity = serde_json::from_value(reply).map_err(|_| invalid())?;
        if !self.matches(&identity) {
            return Err(invalid());
        }
        Ok(identity)
    }

    pub fn publish(&self, owner: &VaultLock) -> AppResult<()> {
        self.validate(&self.root, &self.vault_id, &owner.directory)?;
        let _lock = RootLock::acquire(&self.root)?;
        let raw = serde_json::to_vec(self).map_err(|_| invalid())?;
        crate::atomic_file::write_private(&path(&self.root, &self.vault_id)?, &raw)?;
        Ok(())
    }
}

/// Runs after coordinator election and before index/document migration. Probe
/// every physical profile, including unindexed directories, without trusting
/// discovery-file presence. No IPC runs while the root transaction is held.
pub fn preflight(root: &Path) -> AppResult<()> {
    let directories = {
        let _lock = RootLock::acquire(root)?;
        let mut directories = Vec::new();
        if VaultLock::is_owned(root)? {
            // Legacy/direct root owners have no supervised identity protocol.
            return Err(invalid());
        }
        match fs::read_dir(root.join("profiles")) {
            Ok(entries) => {
                for entry in entries {
                    let entry = entry?;
                    if entry.path().is_dir() && VaultLock::is_owned(&entry.path())? {
                        let id = entry
                            .file_name()
                            .to_str()
                            .filter(|id| crate::profiles::valid_id(id))
                            .ok_or_else(invalid)?
                            .to_owned();
                        directories.push((id, entry.path()));
                    }
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
        directories
    };
    for (id, directory) in directories {
        match reconcile(root, &id, &directory)? {
            Recovery::Vacant => {}
            Recovery::Held(record) => record.identify()?.require_compatible()?,
        }
    }
    Ok(())
}

pub fn reconcile(root: &Path, id: &str, directory: &Path) -> AppResult<Recovery> {
    let file = path(root, id)?;
    if !directory.is_dir() {
        return Err(invalid());
    }
    // A stale or corrupt record is harmless only after the OS grants ownership.
    if let Some(owner) = VaultLock::try_acquire(directory)? {
        let _lock = RootLock::acquire(root)?;
        match fs::remove_file(&file) {
            Ok(()) => crate::atomic_file::sync_directory(file.parent().ok_or_else(invalid)?)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        drop(owner);
        return Ok(Recovery::Vacant);
    }
    let raw = {
        let _lock = RootLock::acquire(root)?;
        let mut raw = Vec::new();
        File::open(file)?.take(8193).read_to_end(&mut raw)?;
        if raw.len() > 8192 {
            return Err(invalid());
        }
        raw
    };
    let registration: Registration = serde_json::from_slice(&raw).map_err(|_| invalid())?;
    registration.validate(root, id, directory)?;
    Ok(Recovery::Held(registration))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn startup_requires_compatible_authenticated_owners_before_document_reconciliation() {
        let (root, directory, owner) = fixture();
        let listener = Coordinator::for_worker(&owner).unwrap();
        let record = Registration::new(
            &root,
            "a",
            &owner,
            Uuid::new_v4(),
            listener.endpoint().clone(),
        )
        .unwrap();
        record.publish(&owner).unwrap();
        let identity = Arc::new(Mutex::new(record.identity(true)));
        let reply = identity.clone();
        let server = listener
            .serve(move |_| Ok(serde_json::to_value(&*reply.lock().unwrap()).unwrap()))
            .unwrap();
        // Inventory uses physical ownership even with a broken/missing index.
        let documents = [
            "profiles.json",
            "ui-settings.json",
            "ui-settings.json.previous",
            "desktop-settings.json",
        ];
        for file in documents {
            fs::write(root.join(file), b"retained bytes").unwrap();
        }
        preflight(&root).unwrap();
        for incompatible in [
            None,
            Some(RuntimeContract {
                protocol: RuntimeContract::current().protocol + 1,
                ..RuntimeContract::current().clone()
            }),
            Some(RuntimeContract {
                storage: RuntimeContract::current().storage + 1,
                ..RuntimeContract::current().clone()
            }),
            Some(RuntimeContract {
                settings_schema: "older ownership schema".into(),
                ..RuntimeContract::current().clone()
            }),
        ] {
            identity.lock().unwrap().contract = incompatible;
            assert!(preflight(&root).is_err());
            assert!(VaultLock::try_acquire(&directory).unwrap().is_none());
            for file in documents {
                assert_eq!(fs::read(root.join(file)).unwrap(), b"retained bytes");
            }
        }
        // Old replies have the same physical identity but no compatibility proof.
        let mut old = serde_json::to_value(record.identity(true)).unwrap();
        old.as_object_mut().unwrap().remove("contract");
        let old: Identity = serde_json::from_value(old).unwrap();
        assert!(record.matches(&old));
        assert!(old.require_compatible().is_err());
        server.stop();
        drop(owner);
        preflight(&root).unwrap();
        for file in documents {
            assert_eq!(fs::read(root.join(file)).unwrap(), b"retained bytes");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unidentified_direct_owners_block_preflight_until_the_os_releases_ownership() {
        let (root, directory, owner) = fixture();
        assert!(preflight(&root).is_err());
        assert!(!root.join("profiles.json").exists());
        assert!(VaultLock::try_acquire(&directory).unwrap().is_none());
        drop(owner);
        preflight(&root).unwrap();
        let legacy = VaultLock::acquire(&root).unwrap();
        assert!(preflight(&root).is_err());
        drop(legacy);
        preflight(&root).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    use crate::coordinator_ipc::Coordinator;

    fn fixture() -> (PathBuf, PathBuf, VaultLock) {
        let root = std::env::temp_dir().join(format!("ms-worker-record-{}", Uuid::new_v4()));
        let directory = root.join("profiles/a");
        let owner = VaultLock::acquire(&directory).unwrap();
        (root, directory, owner)
    }

    #[test]
    fn stale_records_are_removed_only_after_the_os_grants_vault_ownership() {
        let (root, directory, owner) = fixture();
        let listener = Coordinator::for_worker(&owner).unwrap();
        let record = Registration::new(
            &root,
            "a",
            &owner,
            Uuid::new_v4(),
            listener.endpoint().clone(),
        )
        .unwrap();
        record.publish(&owner).unwrap();
        assert!(matches!(
            reconcile(&root, "a", &directory).unwrap(),
            Recovery::Held(_)
        ));
        let file = path(&root, "a").unwrap();
        fs::write(&file, b"corrupt").unwrap();
        assert!(reconcile(&root, "a", &directory).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"corrupt");
        drop(listener);
        drop(owner);
        assert!(matches!(
            reconcile(&root, "a", &directory).unwrap(),
            Recovery::Vacant
        ));
        assert!(!file.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn records_cannot_be_reused_for_other_roots_vaults_or_launches() {
        let (root, directory, owner) = fixture();
        let listener = Coordinator::for_worker(&owner).unwrap();
        let record = Registration::new(
            &root,
            "a",
            &owner,
            Uuid::new_v4(),
            listener.endpoint().clone(),
        )
        .unwrap();
        assert!(record.matches(&record.identity(true)));
        let mut identity = record.identity(true);
        identity.launch_id = Uuid::new_v4();
        assert!(!record.matches(&identity));
        let other = root.join("other-root");
        fs::create_dir_all(&other).unwrap();
        assert!(record.validate(&other, "a", &directory).is_err());
        assert!(record.validate(&root, "b", &directory).is_err());
        assert!(path(&root, "../a").is_err());
        record.publish(&owner).unwrap();
        let file = path(&root, "a").unwrap();
        fs::write(&file, vec![b' '; 8193]).unwrap();
        assert!(reconcile(&root, "a", &directory).is_err());
        assert_eq!(fs::metadata(&file).unwrap().len(), 8193);
        drop(listener);
        drop(owner);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn identity_requires_an_authenticated_reply_from_the_exact_physical_worker() {
        let (root, directory, owner) = fixture();
        let listener = Coordinator::for_worker(&owner).unwrap();
        let record = Registration::new(
            &root,
            "a",
            &owner,
            Uuid::new_v4(),
            listener.endpoint().clone(),
        )
        .unwrap();
        let expected = record.clone();
        let server = listener
            .serve(move |request| {
                assert_eq!(request.payload["launch_id"], expected.launch_id.to_string());
                serde_json::to_value(expected.identity(true)).map_err(|_| "invalid".into())
            })
            .unwrap();
        assert!(record.identify().unwrap().ready);
        drop(owner);
        // A listener and accepted calls must retain ownership even if database
        // state is dropped first during shutdown.
        assert!(VaultLock::try_acquire(&directory).unwrap().is_none());
        server.stop();
        assert!(VaultLock::try_acquire(&directory).unwrap().is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_listening_endpoint_with_the_wrong_identity_cannot_be_adopted() {
        let (root, _, owner) = fixture();
        let listener = Coordinator::for_worker(&owner).unwrap();
        let record = Registration::new(
            &root,
            "a",
            &owner,
            Uuid::new_v4(),
            listener.endpoint().clone(),
        )
        .unwrap();
        let mut identity = record.identity(true);
        identity.directory = root.join("profiles/other");
        let server = listener
            .serve(move |_| Ok(serde_json::to_value(&identity).unwrap()))
            .unwrap();
        assert!(record.identify().is_err());
        server.stop();
        drop(owner);
        fs::remove_dir_all(root).unwrap();
    }
}
