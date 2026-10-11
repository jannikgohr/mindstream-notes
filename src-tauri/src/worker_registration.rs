//! Discovery records never grant ownership. Reconciliation removes stale
//! records only while holding the physical vault's OS lease; live records need
//! an authenticated identity reply before the coordinator can adopt a worker.
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
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
