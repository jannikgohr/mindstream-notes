//! A tar archive read in place.
//!
//! A Joplin `.jex` is a tar of the RAW layout. The app can unpack one into a
//! temporary folder, but a browser has nowhere to put it. A tar stores each
//! file's bytes uncompressed, so this notes where they sit and reads them from
//! the archive on demand, without holding the archive in memory.

use std::collections::BTreeMap;
use std::io::{self, Cursor, Read};
use std::path::{Component, Path};

use crate::error::{AppError, AppResult};

use super::files::{walk_paths, ImportEntry, ImportFiles};

struct TarEntry {
    start: u64,
    size: u64,
}

pub struct TarFiles {
    source: Box<dyn ImportFiles>,
    archive: String,
    entries: BTreeMap<String, TarEntry>,
}

/// The entry's path inside the archive, refusing anything that would climb out
/// of it. Absolute paths, drive prefixes and `..` all disqualify an entry.
fn safe_path(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().to_string()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

impl TarFiles {
    /// Read the archive's index. `archive` names it inside `source`.
    pub fn new(source: Box<dyn ImportFiles>, archive: String) -> AppResult<Self> {
        let unreadable = |err: io::Error| {
            AppError::InvalidArg(format!("not a readable .jex archive: {archive}: {err}"))
        };
        let mut tar = tar::Archive::new(source.stream(&archive).map_err(unreadable)?);
        let mut entries = BTreeMap::new();
        for entry in tar.entries().map_err(unreadable)? {
            let entry = entry.map_err(unreadable)?;
            if !entry.header().entry_type().is_file() {
                continue;
            }
            let path = entry.path().map_err(unreadable)?.into_owned();
            let Some(relative) = safe_path(&path) else {
                log::warn!(
                    "[import] refusing archive entry outside the archive: {}",
                    path.display()
                );
                continue;
            };
            entries.insert(
                relative,
                TarEntry {
                    start: entry.raw_file_position(),
                    size: entry.size(),
                },
            );
        }
        Ok(Self {
            source,
            archive,
            entries,
        })
    }

    fn entry(&self, path: &str) -> io::Result<&TarEntry> {
        self.entries
            .get(path)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, path.to_string()))
    }
}

impl ImportFiles for TarFiles {
    fn walk(&self, skip: &dyn Fn(&str) -> bool) -> Vec<ImportEntry> {
        walk_paths(self.entries.keys().map(String::as_str), skip)
    }

    fn root_files(&self) -> io::Result<Vec<String>> {
        Ok(self
            .entries
            .keys()
            .filter(|path| !path.contains('/'))
            .cloned()
            .collect())
    }

    fn read(&self, path: &str) -> io::Result<Vec<u8>> {
        let entry = self.entry(path)?;
        let size = usize::try_from(entry.size).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "archive entry exceeds address space",
            )
        })?;
        self.read_range(path, 0, size)
    }

    fn read_range(&self, path: &str, start: u64, length: usize) -> io::Result<Vec<u8>> {
        let entry = self.entry(path)?;
        let available = entry.size.saturating_sub(start).min(length as u64) as usize;
        self.source
            .read_range(&self.archive, entry.start + start, available)
    }

    fn stream(&self, path: &str) -> io::Result<Box<dyn Read>> {
        Ok(Box::new(Cursor::new(self.read(path)?)))
    }

    fn is_file(&self, path: &str) -> bool {
        self.entries.contains_key(path)
    }

    fn is_dir(&self, path: &str) -> bool {
        let prefix = format!("{path}/");
        self.entries.keys().any(|entry| entry.starts_with(&prefix))
    }

    fn modified(&self, _path: &str) -> Option<String> {
        None
    }
}
