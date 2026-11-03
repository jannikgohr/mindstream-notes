//! Vault import commands. The engine lives in `storage-core`, so that a browser
//! runs the same code. What stays here is reading from disk and the Tauri glue.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};

use crate::app_events::AppEvent;
use crate::db::Db;
use crate::error::{AppError, AppResult, CommandResult};

pub mod detect;
mod disk;
pub mod legacy_links;
pub mod stage;

#[cfg(test)]
mod tests;

pub use disk::DiskFiles;
pub use mindstream_storage_core::import::{
    build_source, links, markdown, mime, model, source, sources, writer, DetectedSource,
    ImportOptions, ImportProgress, ImportReport, ImportSourceKind, UnresolvedLinks,
    DEFAULT_MAX_ATTACHMENT_BYTES,
};

/// Cancellation flag, shared between the running import and `import_cancel`.
#[derive(Default)]
pub struct ImportState {
    cancelled: Arc<AtomicBool>,
}

impl ImportState {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    fn begin(&self) -> Arc<AtomicBool> {
        self.cancelled.store(false, Ordering::SeqCst);
        Arc::clone(&self.cancelled)
    }
}

fn open_source(kind: ImportSourceKind, root: PathBuf) -> AppResult<Box<dyn source::ImportSource>> {
    let (files, file_name) = match kind {
        ImportSourceKind::JoplinJex => {
            (DiskFiles::staged(stage::extract_tar(&root)?), String::new())
        }
        ImportSourceKind::Evernote => {
            let name = root
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            let parent = root.parent().map(PathBuf::from).unwrap_or_default();
            (DiskFiles::new(parent), name)
        }
        _ => (DiskFiles::new(root), String::new()),
    };
    Ok(build_source(kind, Box::new(files), &file_name))
}

/// Run an import to completion (or to cancellation) and report what landed.
pub fn run_import(
    db: &Db,
    options: ImportOptions,
    cancelled: &AtomicBool,
    on_progress: impl FnMut(ImportProgress),
) -> AppResult<ImportReport> {
    let root = PathBuf::from(&options.source_path);
    let detected = detect::detect(&root)?;
    let kind = options.kind.unwrap_or(detected.kind);
    let mut source = open_source(kind, root)?;
    Ok(mindstream_storage_core::import::run_import(
        db,
        source.as_mut(),
        &options,
        cancelled,
        on_progress,
    )?)
}

// ---------- Source pickers ----------

#[cfg(feature = "e2e-data-dir")]
fn e2e_picker_override(key: &str) -> Option<AppResult<Option<String>>> {
    let raw = std::env::var_os(key)?;
    if raw.is_empty() {
        return Some(Ok(None));
    }
    let path = PathBuf::from(raw);
    Some(
        path.to_str()
            .map(|value| Some(value.to_string()))
            .ok_or_else(|| AppError::InvalidArg(format!("{key} is not valid UTF-8"))),
    )
}

/// Two pickers rather than one, because a native file dialog cannot offer
/// files and folders in the same list on any of our platforms. Obsidian and
/// GFM vaults are folders; Evernote and Joplin ship a single file. The import
/// dialog asks which the user has before opening either.
#[tauri::command]
pub async fn notes_import_pick_folder(app: AppHandle) -> CommandResult<Option<String>> {
    pick_folder_inner(app).await.map_err(Into::into)
}

#[tauri::command]
pub async fn notes_import_pick_file(app: AppHandle) -> CommandResult<Option<String>> {
    pick_file_inner(app).await.map_err(Into::into)
}

#[cfg(desktop)]
async fn pick_folder_inner(app: AppHandle) -> AppResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    #[cfg(feature = "e2e-data-dir")]
    if let Some(result) = e2e_picker_override("MINDSTREAM_E2E_IMPORT_FOLDER") {
        return result;
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Import notes — pick a vault folder")
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });
    resolve_picked(rx).await
}

#[cfg(desktop)]
async fn pick_file_inner(app: AppHandle) -> AppResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    #[cfg(feature = "e2e-data-dir")]
    if let Some(result) = e2e_picker_override("MINDSTREAM_E2E_IMPORT_FILE") {
        return result;
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Import notes — pick an export file")
        .add_filter("Note exports", &["enex", "jex"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    resolve_picked(rx).await
}

#[cfg(desktop)]
async fn resolve_picked(
    rx: tokio::sync::oneshot::Receiver<Option<tauri_plugin_dialog::FilePath>>,
) -> AppResult<Option<String>> {
    let Some(file_path) = rx.await.map_err(|e| AppError::InvalidArg(e.to_string()))? else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|e| AppError::InvalidArg(format!("path conversion: {e}")))?;
    let text = path
        .to_str()
        .ok_or_else(|| AppError::InvalidArg("that path is not valid UTF-8".into()))?;
    Ok(Some(text.to_string()))
}

#[cfg(not(desktop))]
async fn pick_folder_inner(_app: AppHandle) -> AppResult<Option<String>> {
    Err(AppError::InvalidArg(
        "importing notes is not supported on this platform yet".into(),
    ))
}

#[cfg(not(desktop))]
async fn pick_file_inner(_app: AppHandle) -> AppResult<Option<String>> {
    Err(AppError::InvalidArg(
        "importing notes is not supported on this platform yet".into(),
    ))
}

// ---------- Tauri commands ----------

#[tauri::command]
pub async fn notes_import_detect(path: String) -> CommandResult<DetectedSource> {
    // Blocking filesystem probing, off the async runtime's core threads.
    tauri::async_runtime::spawn_blocking(move || detect::detect(&PathBuf::from(path)))
        .await
        .map_err(|err| AppError::InvalidArg(err.to_string()))?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn notes_import_run(
    app: AppHandle,
    options: ImportOptions,
) -> CommandResult<ImportReport> {
    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    let cancelled = app.state::<ImportState>().begin();
    let progress_handle = app.clone();

    // spawn_blocking, not a plain call: an import is minutes of synchronous
    // filesystem and SQLite work, and running it on the command thread would
    // hold up the WebView's IPC.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _job = job;
        let db = progress_handle.state::<Db>();
        run_import(&db, options, &cancelled, |progress| {
            if let Err(err) = progress_handle.emit(AppEvent::ImportProgress.as_str(), &progress) {
                log::warn!("[import] progress emit failed: {err}");
            }
        })
    })
    .await
    .map_err(|err| AppError::InvalidArg(err.to_string()))?;

    result.map_err(Into::into)
}

#[tauri::command]
pub fn notes_import_cancel(state: tauri::State<'_, ImportState>) -> CommandResult<()> {
    state.cancel();
    Ok(())
}
