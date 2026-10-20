//! Compiled components, kept so a plugin is compiled once and not per call.
//!
//! Two levels. In memory, a small LRU of ready-to-instantiate components,
//! keyed by the SHA-256 of the component bytes. On disk, the serialized
//! machine code under `<dir>/<engine>/<sha256>.cwasm`, so the first call after
//! a restart skips Cranelift. `<engine>` is a hash of everything that makes
//! compiled code incompatible (Wasmtime version, target, settings), and a
//! directory for any other value is deleted when an entry is written.
//!
//! Loading compiled code from disk is `unsafe` in Wasmtime because the bytes
//! become native code with no further checks. The cache sits in the app's own
//! data directory, and anything that can write there can already write the
//! database that decides which plugins are approved and which native tools
//! they may run. The cache does not widen that, and a file that fails to load
//! is deleted and compiled again.

use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use wasmtime::component::Component;
use wasmtime::Engine;

/// Components kept compiled in memory. Bundled plugins are few; this bounds
/// what a device with many installed plugins holds.
pub const MEMORY_ENTRIES: usize = 8;
/// Compiled files kept on disk per engine.
pub const DISK_ENTRIES: usize = 32;

pub type Digest32 = [u8; 32];

pub fn digest(bytes: &[u8]) -> Digest32 {
    Sha256::digest(bytes).into()
}

pub fn hex(digest: &Digest32) -> String {
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Where a call's component came from, for timing reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Memory,
    Disk,
    Compiled,
}

/// A least-recently-used map from component digest to compiled value.
#[derive(Debug)]
pub struct Lru<T> {
    entries: Vec<(Digest32, Arc<T>)>,
    capacity: usize,
}

impl<T> Lru<T> {
    pub fn new(capacity: usize) -> Self {
        Self {
            entries: Vec::new(),
            capacity,
        }
    }

    pub fn get(&mut self, key: &Digest32) -> Option<Arc<T>> {
        let index = self.entries.iter().position(|(k, _)| k == key)?;
        let entry = self.entries.remove(index);
        let value = entry.1.clone();
        self.entries.push(entry);
        Some(value)
    }

    pub fn insert(&mut self, key: Digest32, value: Arc<T>) {
        self.entries.retain(|(k, _)| *k != key);
        self.entries.push((key, value));
        while self.entries.len() > self.capacity {
            self.entries.remove(0);
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

/// The on-disk cache for one engine.
#[derive(Debug, Clone)]
pub struct Disk {
    root: PathBuf,
    dir: PathBuf,
}

impl Disk {
    pub fn new(root: &Path, engine: &Engine) -> Self {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        engine.precompile_compatibility_hash().hash(&mut hasher);
        let dir = root.join(format!("{:016x}", hasher.finish()));
        Self {
            root: root.to_path_buf(),
            dir,
        }
    }

    fn path(&self, key: &Digest32) -> PathBuf {
        self.dir.join(format!("{}.cwasm", hex(key)))
    }

    /// The compiled component for `key`, if a usable one is on disk.
    pub fn load(&self, engine: &Engine, key: &Digest32) -> Option<Component> {
        let path = self.path(key);
        if !path.is_file() {
            return None;
        }
        // SAFETY: the file was written by `store` below from
        // `Component::serialize` of an engine with this compatibility hash,
        // in the app's own data directory (see the module comment for why
        // that directory is trusted). Wasmtime still checks the header and
        // refuses an incompatible file, which is then deleted.
        match unsafe { Component::deserialize_file(engine, &path) } {
            Ok(component) => {
                // Touch it, so pruning keeps what is in use.
                let _ = fs::File::options()
                    .append(true)
                    .open(&path)
                    .and_then(|f| f.set_modified(std::time::SystemTime::now()));
                Some(component)
            }
            Err(e) => {
                log::warn!(
                    "[plugins] dropping unusable compiled plugin {}: {e}",
                    path.display()
                );
                let _ = fs::remove_file(&path);
                None
            }
        }
    }

    /// Write a compiled component. Failures only cost the next start a
    /// compile, so they are logged and swallowed.
    pub fn store(&self, key: &Digest32, compiled: &[u8]) {
        if let Err(e) = self.try_store(key, compiled) {
            log::warn!("[plugins] could not cache a compiled plugin: {e}");
        }
    }

    fn try_store(&self, key: &Digest32, compiled: &[u8]) -> std::io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let path = self.path(key);
        let tmp = self
            .dir
            .join(format!(".{}.{}.tmp", hex(key), uuid::Uuid::new_v4()));
        fs::write(&tmp, compiled)?;
        fs::rename(&tmp, &path).inspect_err(|_| {
            let _ = fs::remove_file(&tmp);
        })?;
        self.prune();
        Ok(())
    }

    /// Drop other engines' directories and all but the newest
    /// [`DISK_ENTRIES`] files of this one.
    fn prune(&self) {
        if let Ok(siblings) = fs::read_dir(&self.root) {
            for entry in siblings.flatten() {
                let path = entry.path();
                if path != self.dir && path.is_dir() {
                    let _ = fs::remove_dir_all(&path);
                }
            }
        }
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
            .flatten()
            .filter_map(|e| {
                let path = e.path();
                let modified = e.metadata().ok()?.modified().ok()?;
                (path.extension()? == "cwasm").then_some((modified, path))
            })
            .collect();
        if files.len() <= DISK_ENTRIES {
            return;
        }
        files.sort();
        for (_, path) in &files[..files.len() - DISK_ENTRIES] {
            let _ = fs::remove_file(path);
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lru_evicts_the_least_recently_used() {
        let mut lru = Lru::new(2);
        assert!(lru.is_empty());
        lru.insert([1; 32], Arc::new("one"));
        lru.insert([2; 32], Arc::new("two"));
        // Touch one, so two is now the oldest.
        assert_eq!(*lru.get(&[1; 32]).unwrap(), "one");
        lru.insert([3; 32], Arc::new("three"));
        assert!(lru.get(&[2; 32]).is_none());
        assert!(lru.get(&[1; 32]).is_some());
        // Re-inserting a key replaces it rather than duplicating it.
        lru.insert([1; 32], Arc::new("uno"));
        assert_eq!(lru.len(), 2);
        assert_eq!(*lru.get(&[1; 32]).unwrap(), "uno");
        lru.clear();
        assert!(lru.is_empty());
    }

    #[test]
    fn digests_are_sha256_hex() {
        assert_eq!(
            hex(&digest(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn a_missing_or_corrupt_file_is_not_loaded() {
        let root = std::env::temp_dir().join(format!("ms-cwasm-{}", uuid::Uuid::new_v4()));
        let engine = Engine::default();
        let disk = Disk::new(&root, &engine);
        let key = [7; 32];
        assert!(disk.load(&engine, &key).is_none());
        disk.store(&key, b"not compiled code");
        assert!(disk.path(&key).exists());
        assert!(disk.load(&engine, &key).is_none());
        assert!(!disk.path(&key).exists(), "the unusable file is deleted");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pruning_keeps_the_newest_and_drops_other_engines() {
        let root = std::env::temp_dir().join(format!("ms-cwasm-{}", uuid::Uuid::new_v4()));
        let engine = Engine::default();
        let disk = Disk::new(&root, &engine);
        let stale = root.join("0000000000000000");
        fs::create_dir_all(&stale).unwrap();
        for i in 0..(DISK_ENTRIES + 3) {
            disk.store(&[i as u8; 32], b"x");
        }
        let kept = fs::read_dir(disk.dir()).unwrap().count();
        assert_eq!(kept, DISK_ENTRIES);
        assert!(!stale.exists());
        fs::remove_dir_all(root).ok();
    }
}
