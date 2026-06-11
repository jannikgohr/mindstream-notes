//! Notes-as-files export — writes each note to its own file on disk
//! (markdown / excalidraw / pdf), preserving the folder hierarchy.
//!
//! The actual content serialisation lives in the TS driver (see
//! `src/lib/notes-export/`) — each note kind needs format-specific
//! handling (frontmatter for markdown, Y.Doc unpacking for freeform,
//! asset-bytes extraction for pdf) that's much cheaper to do on the
//! side where those types already exist.
//!
//! This Rust module is the file-system shim: pop the folder picker,
//! then service per-file write calls from the driver. The write
//! command enforces a path-traversal guard so a malicious relative
//! path can't escape the chosen export root.

use std::fs;
use std::path::{Component, Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

use crate::error::{AppError, AppResult};

/// Pop a folder picker for the export destination. Returns `None` if
/// the user cancels.
#[tauri::command]
pub async fn notes_export_pick_dir(app: AppHandle) -> Result<Option<String>, String> {
    pick_dir_inner(app).await.map_err(Into::into)
}

async fn pick_dir_inner(app: AppHandle) -> AppResult<Option<String>> {
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("Export notes — pick a destination folder")
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });
    let Some(file_path) = rx.await.map_err(|e| AppError::InvalidArg(e.to_string()))? else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|e| AppError::InvalidArg(format!("path conversion: {e}")))?;
    let path_str = path
        .to_str()
        .ok_or_else(|| AppError::InvalidArg("destination path is not valid UTF-8".into()))?;
    Ok(Some(path_str.to_string()))
}

/// Write a file under `root` at `relative_path`. The relative path is
/// validated to ensure it cannot escape `root` via `..` or absolute
/// components — any joined path that doesn't canonicalise back to a
/// child of `root` is refused.
#[tauri::command]
pub fn notes_export_write_file(
    root: String,
    relative_path: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    write_under(&PathBuf::from(&root), &relative_path, &bytes).map_err(Into::into)
}

fn write_under(root: &Path, relative_path: &str, bytes: &[u8]) -> AppResult<()> {
    let target = resolve_inside_root(root, relative_path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&target, bytes)?;
    Ok(())
}

/// Join `relative_path` onto `root` and reject any path whose
/// components include `..` or an absolute prefix that would let the
/// final target escape the root directory.
///
/// We don't rely on `canonicalize` because the target file doesn't
/// exist yet — `canonicalize` requires the path to be present on
/// disk. Instead we walk components ourselves and forbid anything
/// that could climb above `root`.
fn resolve_inside_root(root: &Path, relative_path: &str) -> AppResult<PathBuf> {
    let rel = Path::new(relative_path);
    if rel.is_absolute() {
        return Err(AppError::InvalidArg(format!(
            "absolute path not allowed in export: {relative_path}"
        )));
    }
    let mut out = root.to_path_buf();
    for component in rel.components() {
        match component {
            // `.` is a no-op; allow.
            Component::CurDir => {}
            // Bare names extend the path normally.
            Component::Normal(name) => out.push(name),
            // Everything else (root, prefix, parent) would either
            // re-anchor or climb above the export root.
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::InvalidArg(format!(
                    "path escapes export root: {relative_path}"
                )));
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_accepts_plain_relative_paths() {
        let root = PathBuf::from("/export/root");
        let target = resolve_inside_root(&root, "Folder/Note.md").unwrap();
        assert_eq!(target, PathBuf::from("/export/root/Folder/Note.md"));
    }

    #[test]
    fn resolve_accepts_curdir_segments() {
        let root = PathBuf::from("/export/root");
        let target = resolve_inside_root(&root, "./Folder/./Note.md").unwrap();
        assert_eq!(target, PathBuf::from("/export/root/Folder/Note.md"));
    }

    #[test]
    fn resolve_rejects_parent_dir_traversal() {
        let root = PathBuf::from("/export/root");
        let err = resolve_inside_root(&root, "../escape.md").unwrap_err();
        assert!(
            err.to_string().contains("escapes"),
            "expected traversal rejection, got {err}"
        );
    }

    #[test]
    fn resolve_rejects_parent_dir_in_the_middle() {
        let root = PathBuf::from("/export/root");
        let err = resolve_inside_root(&root, "Folder/../../etc/passwd").unwrap_err();
        assert!(err.to_string().contains("escapes"), "got {err}");
    }

    #[test]
    fn resolve_rejects_absolute_paths() {
        let root = PathBuf::from("/export/root");
        let err = resolve_inside_root(&root, "/etc/passwd").unwrap_err();
        assert!(
            err.to_string().contains("absolute") || err.to_string().contains("escapes"),
            "got {err}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn resolve_rejects_windows_drive_prefix() {
        let root = PathBuf::from(r"C:\export\root");
        let err = resolve_inside_root(&root, r"D:\elsewhere\file.md").unwrap_err();
        assert!(
            err.to_string().contains("absolute") || err.to_string().contains("escapes"),
            "got {err}"
        );
    }

    #[test]
    fn write_under_creates_parent_dirs() {
        let tmp = std::env::temp_dir().join(format!("ms-notes-export-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        write_under(&tmp, "a/b/c/note.md", b"hello").unwrap();
        let body = fs::read(tmp.join("a/b/c/note.md")).unwrap();
        assert_eq!(body, b"hello");
        fs::remove_dir_all(&tmp).ok();
    }
}
