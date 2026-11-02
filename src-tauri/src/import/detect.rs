//! Working out which format the user just pointed at.
//!
//! Detection is a hint, never a verdict: the import dialog shows what was
//! detected and lets the user override it, because a vault can be ambiguous
//! (an Obsidian vault with its `.obsidian` folder stripped is a GFM folder,
//! and importing it as one is perfectly reasonable).

use std::path::Path;

use crate::error::{AppError, AppResult};

use super::DiskFiles;
pub use mindstream_storage_core::import::detect::*;

pub fn detect(path: &Path) -> AppResult<DetectedSource> {
    if !path.exists() {
        return Err(AppError::NotFound(format!("{}", path.display())));
    }
    if !path.is_dir() {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        let Some(kind) = detect_file_kind(&name) else {
            return Err(AppError::InvalidArg(
                "pick a folder of notes, an Evernote .enex file, or a Joplin .jex export".into(),
            ));
        };
        return Ok(DetectedSource {
            kind,
            path: path.to_string_lossy().to_string(),
            suggested_name: file_stem_name(path),
        });
    }
    Ok(DetectedSource {
        kind: detect_directory_kind(&DiskFiles::new(path.to_path_buf())),
        path: path.to_string_lossy().to_string(),
        suggested_name: suggested_name(path),
    })
}

/// Destination-folder name for an archive: the file name without its
/// extension, so `MyNotes.jex` suggests "MyNotes".
fn file_stem_name(path: &Path) -> String {
    path.file_stem()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Imported notes".to_string())
}

/// The folder's own name, falling back to something usable when the user
/// picked a drive root (whose file name is empty).
fn suggested_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Imported notes".to_string())
}
