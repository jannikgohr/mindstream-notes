//! Publish complete documents without truncating or deleting the previous file.
//!
//! Callers still need an operation lock around read/modify/write transactions.
//! The temporary file is on the same filesystem and flushed before replacement.
//! Unix also flushes the parent directory; Windows directory-entry durability
//! requires separate platform verification, not just a process-crash test.

#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

struct TemporaryFile(PathBuf);

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub fn write(path: &Path, contents: &[u8]) -> io::Result<()> {
    write_with_privacy(path, contents, false)
}

/// Endpoint records carry an IPC secret. Unix publication starts with mode
/// 0600; Windows inherits the application data directory's user ACL.
pub fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    write_with_privacy(path, contents, true)
}

fn write_with_privacy(path: &Path, contents: &[u8], private: bool) -> io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let temporary_path = parent.join(format!(".write-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(not(unix))]
    let _ = private;
    let mut file = options.open(&temporary_path)?;
    // A create_new failure must not remove a pre-existing path.
    let temporary = TemporaryFile(temporary_path);
    file.write_all(contents)?;
    file.sync_all()?;
    drop(file);
    // rename replaces an existing file on both Unix and Windows. Never remove
    // the destination first: a failed publication must leave its bytes intact.
    fs::rename(&temporary.0, path)?;
    sync_directory(parent)
}

pub fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Flush an existing file after SQLite has closed/checkpointed it.
pub fn sync_file(path: &Path) -> io::Result<()> {
    OpenOptions::new().write(true).open(path)?.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("ms-atomic-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn replaces_existing_document_without_trailing_bytes() {
        let root = root();
        let path = root.join("settings.json");
        write(&path, br#"{"language":"english"}"#).unwrap();
        write(&path, b"{}").unwrap();
        assert_eq!(fs::read(path).unwrap(), b"{}");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_replacement_preserves_destination_and_removes_temporary_file() {
        let root = root();
        let path = root.join("settings.json");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("keep"), b"original").unwrap();
        assert!(write(&path, b"replacement").is_err());
        assert_eq!(fs::read(path.join("keep")).unwrap(), b"original");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn readers_only_observe_complete_documents_during_replacement() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let root = root();
        let path = root.join("settings.json");
        let first = vec![b'a'; 32 * 1024];
        let second = vec![b'b'; 16 * 1024];
        write(&path, &first).unwrap();
        let finished = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                while !finished.load(Ordering::Acquire) {
                    let bytes = fs::read(&path).unwrap();
                    assert!(bytes == first || bytes == second);
                }
            });
            for _ in 0..20 {
                write(&path, &second).unwrap();
                write(&path, &first).unwrap();
            }
            finished.store(true, Ordering::Release);
        });
        fs::remove_dir_all(root).unwrap();
    }
}
