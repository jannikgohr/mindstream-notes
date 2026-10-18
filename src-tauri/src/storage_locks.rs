//! OS ownership, never lock-file presence or process liveness heuristics.
use std::fs::{self, File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::error::{AppError, AppResult};

fn open_lock(directory: &Path, name: &str) -> AppResult<(PathBuf, File)> {
    fs::create_dir_all(directory)?;
    let directory = fs::canonicalize(directory)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join(name))?;
    // std's handles are non-inheritable on Windows and close-on-exec on Unix.
    Ok((directory, file))
}

pub struct RootLock {
    _file: File,
}

impl RootLock {
    pub fn acquire(root: &Path) -> AppResult<Self> {
        let (_, file) = open_lock(root, ".root.lock")?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(Self { _file: file }),
                Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(TryLockError::WouldBlock) => {
                    return Err(AppError::InvalidArg(
                        "app root is busy; retry the operation".into(),
                    ))
                }
                Err(TryLockError::Error(err)) => return Err(err.into()),
            }
        }
    }
}

pub struct VaultLock {
    pub directory: PathBuf,
    file: Arc<File>,
}

impl VaultLock {
    /// Read-only ownership probe for startup preflight. Does not create a
    /// directory/lock file or interpret deletion markers before reconciliation.
    pub(crate) fn is_owned(directory: &Path) -> AppResult<bool> {
        let file = match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(directory.join(".vault.lock"))
        {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(err) => return Err(err.into()),
        };
        match file.try_lock() {
            Ok(()) => Ok(false),
            Err(TryLockError::WouldBlock) => Ok(true),
            Err(TryLockError::Error(err)) => Err(err.into()),
        }
    }

    pub(crate) fn retain_lease(&self) -> Arc<File> {
        self.file.clone()
    }
    pub fn acquire(directory: &Path) -> AppResult<Self> {
        Self::try_acquire(directory)?.ok_or_else(|| Self::busy(directory))
    }

    /// Probe ownership through the OS. None means a live lock owner, never a
    /// stale file, PID, timeout or heartbeat decision.
    pub fn try_acquire(directory: &Path) -> AppResult<Option<Self>> {
        Self::acquire_inner(directory, false)
    }

    pub(crate) fn acquire_for_delete(directory: &Path) -> AppResult<Self> {
        Self::acquire_inner(directory, true)?.ok_or_else(|| Self::busy(directory))
    }

    fn busy(directory: &Path) -> AppError {
        AppError::InvalidArg(format!("vault is already open: {}", directory.display()))
    }

    fn acquire_inner(directory: &Path, deleting: bool) -> AppResult<Option<Self>> {
        let (directory, file) = open_lock(directory, ".vault.lock")?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Ok(None),
            Err(TryLockError::Error(err)) => return Err(err.into()),
        }
        if !deleting && directory.join(".vault-deleting").try_exists()? {
            return Err(AppError::InvalidArg("vault deletion is pending".into()));
        }
        Ok(Some(Self {
            directory,
            file: Arc::new(file),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preflight_probe_observes_os_ownership_without_creating_or_reconciling_files() {
        let root = std::env::temp_dir().join(format!("ms-probe-{}", uuid::Uuid::new_v4()));
        assert!(!VaultLock::is_owned(&root).unwrap());
        assert!(!root.exists());
        fs::create_dir_all(&root).unwrap();
        assert!(!VaultLock::is_owned(&root).unwrap());
        assert!(!root.join(".vault.lock").exists());
        let owner = VaultLock::acquire(&root).unwrap();
        fs::write(root.join(".vault-deleting"), b"retained journal").unwrap();
        assert!(VaultLock::is_owned(&root).unwrap());
        drop(owner);
        assert!(!VaultLock::is_owned(&root).unwrap());
        assert_eq!(
            fs::read(root.join(".vault-deleting")).unwrap(),
            b"retained journal"
        );
        assert!(root.join(".vault.lock").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn ownership_uses_physical_directory_and_survives_stale_files() {
        let root = std::env::temp_dir().join(format!("ms-owner-{}", uuid::Uuid::new_v4()));
        let first = VaultLock::acquire(&root).unwrap();
        assert!(VaultLock::acquire(&root.join(".")).is_err());
        drop(first);
        assert!(root.join(".vault.lock").exists());
        drop(VaultLock::acquire(&root).unwrap());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn lock_child() {
        let Some(root) = std::env::var_os("MINDSTREAM_TEST_LOCK_ROOT") else {
            return;
        };
        let owner = VaultLock::acquire(Path::new(&root)).unwrap();
        fs::write(owner.directory.join("ready"), b"ready").unwrap();
        std::thread::sleep(Duration::from_secs(30));
    }
    #[test]
    fn killed_process_releases_ownership_without_removing_lock_file() {
        let root = std::env::temp_dir().join(format!("ms-owner-{}", uuid::Uuid::new_v4()));
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "storage_locks::tests::lock_child"])
            .env("MINDSTREAM_TEST_LOCK_ROOT", &root)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !root.join("ready").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let ready = root.join("ready").exists();
        let rejected = ready && VaultLock::acquire(&root).is_err();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(ready && rejected);
        drop(VaultLock::acquire(&root).unwrap());
        assert!(root.join(".vault.lock").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
