//! Unpacking archive-shaped sources into a temporary directory.
//!
//! A Joplin `.jex` is a tar of exactly the RAW directory layout, so extracting
//! it first means one parser serves both. The same will hold for a zipped
//! vault.
//!
//! Extraction is guarded against path traversal: an archive entry naming
//! `../../etc/passwd` is refused rather than written. Archives here are
//! user-supplied files, so that is not a theoretical concern.

use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, AppResult};

/// A temporary directory that deletes itself when dropped.
///
/// Held by the source for the whole run: the extracted files are read lazily
/// in phase 2, so cleaning up any earlier would pull the vault out from under
/// the import.
pub struct StagedArchive {
    path: PathBuf,
}

impl StagedArchive {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for StagedArchive {
    fn drop(&mut self) {
        if let Err(err) = fs::remove_dir_all(&self.path) {
            log::warn!(
                "[import] could not clean up staging dir {}: {err}",
                self.path.display()
            );
        }
    }
}

/// Extract a tar archive (a Joplin `.jex`) into a fresh temporary directory.
pub fn extract_tar(archive: &Path) -> AppResult<StagedArchive> {
    let staged = StagedArchive {
        path: std::env::temp_dir().join(format!("mindstream-import-{}", uuid::Uuid::new_v4())),
    };
    fs::create_dir_all(&staged.path)?;

    let file = fs::File::open(archive)
        .map_err(|err| AppError::InvalidArg(format!("{}: {err}", archive.display())))?;
    let mut tar = tar::Archive::new(file);
    for entry in tar
        .entries()
        .map_err(|err| AppError::InvalidArg(format!("not a readable .jex archive: {err}")))?
    {
        let mut entry = entry.map_err(|err| AppError::InvalidArg(err.to_string()))?;
        let entry_path = entry
            .path()
            .map_err(|err| AppError::InvalidArg(err.to_string()))?
            .into_owned();
        let Some(target) = safe_join(&staged.path, &entry_path) else {
            log::warn!(
                "[import] refusing archive entry outside the staging dir: {}",
                entry_path.display()
            );
            continue;
        };
        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        entry
            .unpack(&target)
            .map_err(|err| AppError::InvalidArg(err.to_string()))?;
    }
    Ok(staged)
}

/// Join an archive-relative path onto `root`, refusing anything that would
/// escape it. Absolute paths, drive prefixes and `..` all disqualify an entry.
fn safe_join(root: &Path, relative: &Path) -> Option<PathBuf> {
    let mut out = root.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(out)
}
