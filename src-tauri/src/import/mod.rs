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

#[cfg(test)]
mod tests;

pub use disk::DiskFiles;
use mindstream_storage_core::import::run_import_in_one_transaction;
pub use mindstream_storage_core::import::{
    build_source, links, markdown, mime, model, source, sources, writer, DetectedSource,
    ImportOptions, ImportProgress, ImportReport, ImportSourceKind, UnresolvedLinks,
    DEFAULT_MAX_ATTACHMENT_BYTES,
};

/// Cancellation flag, shared between the running import and `import_cancel`.
#[derive(Default)]
pub struct ImportState {
    cancelled: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
}

impl ImportState {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    /// An import holds the database's write lock until it ends, so anything
    /// else that writes waits for this to turn false.
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Claim the one import slot. `None` while another import runs.
    fn begin(&self) -> Option<(Arc<AtomicBool>, Running)> {
        if self.running.swap(true, Ordering::SeqCst) {
            return None;
        }
        self.cancelled.store(false, Ordering::SeqCst);
        Some((
            Arc::clone(&self.cancelled),
            Running(Arc::clone(&self.running)),
        ))
    }
}

/// Held for as long as an import runs. Dropping it, however the run ends,
/// frees the slot.
struct Running(Arc<AtomicBool>);

impl Drop for Running {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Tells every window, once dropped, that the import is over.
struct AnnounceFinished(AppHandle);

impl Drop for AnnounceFinished {
    fn drop(&mut self) {
        let finished = ImportProgress {
            phase: "finished",
            done: 0,
            total: 0,
            committed: ImportReport::default(),
        };
        if let Err(err) = self.0.emit(AppEvent::ImportProgress.as_str(), &finished) {
            log::warn!("[import] finished emit failed: {err}");
        }
    }
}

fn open_source(kind: ImportSourceKind, root: PathBuf) -> AppResult<Box<dyn source::ImportSource>> {
    let (files, file_name) = match kind {
        ImportSourceKind::JoplinJex | ImportSourceKind::Evernote => {
            let name = root
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            let parent = root.parent().map(PathBuf::from).unwrap_or_default();
            (DiskFiles::new(parent), name)
        }
        _ => (DiskFiles::new(root), String::new()),
    };
    let files = mindstream_storage_core::import::open_files(kind, Box::new(files), &file_name)?;
    Ok(build_source(kind, files, &file_name))
}

/// Run an import to completion (or to cancellation) and report what landed.
/// Run an import as one transaction: all of it lands, or a cancel, a failure
/// or a crash leaves none of it.
///
/// The transaction runs on a connection of its own. The app's connection
/// stays free, so the app keeps reading (WAL shows it the vault as it was
/// before the import) and a write there fails at once with "database is
/// locked" instead of waiting minutes on the main thread. The frontend holds
/// its writes until the import ends, see `storage/import-activity`.
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
    let path = db.with_conn(|conn| {
        Ok(conn
            .path()
            .filter(|path| !path.is_empty())
            .map(PathBuf::from))
    })?;
    let Some(path) = path else {
        // An in-memory database, as in tests, has no file for a second
        // connection to open.
        return db.with_conn_mut(|conn| {
            Ok(run_import_in_one_transaction(
                conn,
                source.as_mut(),
                &options,
                cancelled,
                on_progress,
            )?)
        });
    };
    let mut conn = rusqlite::Connection::open(path)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // A save on the app's connection may hold the write lock for a moment
    // when the import starts.
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    Ok(run_import_in_one_transaction(
        &mut conn,
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
    let Some((cancelled, running)) = app.state::<ImportState>().begin() else {
        return Err(AppError::InvalidArg("Another import is still running.".into()).into());
    };
    let progress_handle = app.clone();
    // Windows hold their writes from the first progress event on; this one
    // goes out before the import takes the write lock.
    let starting = ImportProgress {
        phase: "scanning",
        done: 0,
        total: 0,
        committed: ImportReport::default(),
    };
    if let Err(err) = app.emit(AppEvent::ImportProgress.as_str(), &starting) {
        log::warn!("[import] progress emit failed: {err}");
    }
    // A sync that is already running writes through the app's connection
    // until it ends, and the import's transaction would make those writes
    // fail. Claiming the slot stops new syncs; this waits out the running one
    // and keeps the next from starting until the import is over.
    let scheduler = app.try_state::<crate::sync::scheduler::SyncScheduler>();
    let _sync = match &scheduler {
        Some(scheduler) => Some(scheduler.acquire_in_flight().await),
        None => None,
    };

    // spawn_blocking, not a plain call: an import is minutes of synchronous
    // filesystem and SQLite work, and running it on the command thread would
    // hold up the WebView's IPC.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _job = job;
        // Dropped in reverse: the slot is free by the time windows hear.
        let _finished = AnnounceFinished(progress_handle.clone());
        let _running = running;
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

/// Refuse a write that would meet a running import's lock. For native
/// callers the frontend's write gate does not cover, such as the tray and
/// global shortcuts.
pub fn refuse_while_importing(app: &AppHandle) -> AppResult<()> {
    if app
        .try_state::<ImportState>()
        .is_some_and(|import| import.is_running())
    {
        return Err(AppError::InvalidArg(
            "Notes are being imported. Try again once the import is done.".into(),
        ));
    }
    Ok(())
}

/// Whether an import is running, for a window that opens during one.
#[tauri::command]
pub fn notes_import_running(state: tauri::State<'_, ImportState>) -> bool {
    state.is_running()
}
