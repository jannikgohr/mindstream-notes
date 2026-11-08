//! Native export sessions.
//!
//! The frontend renders each exported file and sends it here in bounded
//! chunks, and attachments are copied straight from the asset store, so no
//! export crosses IPC whole. That matters most on Android, where the bridge
//! turns every byte of a request into JSON.
//!
//! A session writes into one target:
//! - `folder`: files under a folder the user picked.
//! - `archive`: a ZIP built in private app storage, then streamed to the file
//!   the user picks when the session finishes.
//! - `file`: one file staged the same way, for single-note exports.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Deserialize;
use tauri::ipc::Request;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::sync::oneshot;
use zip::write::FileOptions;
use zip::CompressionMethod;

use crate::db::Db;
use crate::error::{AppError, AppResult, CommandError, CommandResult};
use crate::notes_export::resolve_inside_root;

/// The frontend sends 1 MiB chunks. Anything far larger is a caller bug.
const MAX_CHUNK_BYTES: usize = 16 * 1024 * 1024;
/// Asset lookups per call, so a single request stays small.
const MAX_ASSET_IDS: usize = 10_000;
/// Copy buffer for streaming a staged export to its destination.
const COPY_BUFFER_BYTES: usize = 1024 * 1024;
const STAGING_DIR: &str = "exports/.staging";

#[derive(Default)]
pub struct ExportSessions {
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
    /// Whether this run has cleared staging left behind by an earlier one.
    /// Held while sweeping, so the sweep happens once, before any staged
    /// session of this run exists, and never touches a live export.
    swept: Mutex<bool>,
}

impl ExportSessions {
    fn map(&self) -> MutexGuard<'_, HashMap<String, Arc<Mutex<Session>>>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn insert(&self, token: String, session: Session) {
        self.map().insert(token, Arc::new(Mutex::new(session)));
    }

    fn get(&self, token: &str) -> AppResult<Arc<Mutex<Session>>> {
        self.map().get(token).cloned().ok_or_else(unknown)
    }

    fn take(&self, token: &str) -> AppResult<Arc<Mutex<Session>>> {
        self.map().remove(token).ok_or_else(unknown)
    }

    /// Clear what an earlier run left in `staging`, such as an export the app
    /// crashed during. Only the first call of a run sweeps.
    fn sweep_once(&self, staging: &Path) {
        let mut swept = self.swept.lock().unwrap_or_else(|e| e.into_inner());
        if !*swept {
            sweep_staging(staging);
            *swept = true;
        }
    }
}

fn unknown() -> AppError {
    AppError::InvalidArg("Unknown or finished export".into())
}

fn lock(session: &Mutex<Session>) -> MutexGuard<'_, Session> {
    session.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExportTarget {
    Folder { root: String },
    Archive,
    File,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub suggested_name: String,
    pub dialog_title: Option<String>,
    pub filter_name: String,
    pub extensions: Vec<String>,
}

impl SaveRequest {
    fn validate(&self) -> AppResult<()> {
        if self.filter_name.trim().is_empty()
            || self.extensions.is_empty()
            || self.extensions.len() > 8
            || self.extensions.iter().any(|ext| {
                ext.is_empty() || ext.len() > 16 || !ext.bytes().all(|b| b.is_ascii_alphanumeric())
            })
        {
            return Err(AppError::InvalidArg("Invalid export file filter".into()));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteMetadata {
    token: String,
    path: String,
    /// True for the first chunk of a file, which opens it.
    first: bool,
    /// The whole file's size, known up front, so archives can mark large
    /// entries as ZIP64.
    size: u64,
}

enum Sink {
    Folder(PathBuf),
    // Boxed: the writer is several KiB, the other variants a few words.
    Archive(Option<Box<zip::ZipWriter<BufWriter<File>>>>),
    File,
}

struct Open {
    path: String,
    /// Folder and single-file targets write a file. An archive writes into
    /// its current entry instead.
    file: Option<BufWriter<File>>,
}

pub struct Session {
    sink: Sink,
    /// Private directory holding a staged export. It is deleted with the
    /// session, whether the export finished, failed or was abandoned.
    directory: Option<PathBuf>,
    open: Option<Open>,
    entries: usize,
}

impl Drop for Session {
    fn drop(&mut self) {
        // Close the staged files first: fields drop only after this body, and
        // a file that is still open may not be deletable on Windows.
        self.open = None;
        self.sink = Sink::File;
        if let Some(directory) = &self.directory {
            let _ = fs::remove_dir_all(directory);
        }
    }
}

impl Session {
    pub fn folder(root: PathBuf) -> AppResult<Self> {
        if !root.is_dir() {
            return Err(AppError::InvalidArg("Export folder does not exist".into()));
        }
        Ok(Self {
            sink: Sink::Folder(root),
            directory: None,
            open: None,
            entries: 0,
        })
    }

    pub fn staged(directory: PathBuf, archive: bool) -> AppResult<Self> {
        fs::create_dir_all(&directory)?;
        let sink = if archive {
            let file = File::create(directory.join("export.zip"))?;
            Sink::Archive(Some(Box::new(zip::ZipWriter::new(BufWriter::new(file)))))
        } else {
            Sink::File
        };
        Ok(Self {
            sink,
            directory: Some(directory),
            open: None,
            entries: 0,
        })
    }

    fn staged_path(&self) -> Option<PathBuf> {
        let name = match self.sink {
            Sink::Archive(_) => "export.zip",
            Sink::File => "export.bin",
            Sink::Folder(_) => return None,
        };
        self.directory
            .as_ref()
            .map(|directory| directory.join(name))
    }

    /// Open `path` for writing, closing the previous file.
    pub fn start(&mut self, path: &str, size: u64) -> AppResult<()> {
        self.close_entry()?;
        let staged = self.staged_path();
        let entries = self.entries;
        let file = match &mut self.sink {
            Sink::Folder(root) => {
                let target = resolve_inside_root(root, path)?;
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                }
                Some(BufWriter::new(File::create(target)?))
            }
            Sink::Archive(zip) => {
                let name = archive_name(path)?;
                let method = if compressible(&name) {
                    CompressionMethod::Deflated
                } else {
                    CompressionMethod::Stored
                };
                let options: FileOptions<()> = FileOptions::default()
                    .compression_method(method)
                    .unix_permissions(0o644)
                    .large_file(size >= u64::from(u32::MAX));
                zip.as_mut()
                    .ok_or_else(finished)?
                    .start_file(name, options)
                    .map_err(zip_error)?;
                None
            }
            Sink::File => {
                if entries > 0 {
                    return Err(AppError::InvalidArg(
                        "A single-file export holds one file".into(),
                    ));
                }
                Some(BufWriter::new(File::create(staged.ok_or_else(finished)?)?))
            }
        };
        self.entries += 1;
        self.open = Some(Open {
            path: path.to_string(),
            file,
        });
        Ok(())
    }

    /// Append bytes to the open file, which must be `path`.
    pub fn append(&mut self, path: &str, bytes: &[u8]) -> AppResult<()> {
        let open = self
            .open
            .as_mut()
            .filter(|open| open.path == path)
            .ok_or_else(|| AppError::InvalidArg(format!("Export file is not open: {path}")))?;
        match (&mut open.file, &mut self.sink) {
            (Some(file), _) => file.write_all(bytes)?,
            (None, Sink::Archive(Some(zip))) => zip.write_all(bytes)?,
            _ => return Err(finished()),
        }
        Ok(())
    }

    fn close_entry(&mut self) -> AppResult<()> {
        if let Some(Open {
            file: Some(mut file),
            ..
        }) = self.open.take()
        {
            file.flush()?;
        }
        Ok(())
    }

    /// Complete the export. Returns the staged file to copy, if any.
    pub fn finish(&mut self) -> AppResult<Option<PathBuf>> {
        self.close_entry()?;
        if let Sink::Archive(zip) = &mut self.sink {
            let writer = zip.take().ok_or_else(finished)?;
            let mut file = writer.finish().map_err(zip_error)?;
            file.flush()?;
        }
        if matches!(self.sink, Sink::File) && self.entries == 0 {
            return Err(AppError::InvalidArg("The export has no file".into()));
        }
        Ok(self.staged_path())
    }
}

fn finished() -> AppError {
    AppError::InvalidArg("The export is already finished".into())
}

fn zip_error(e: zip::result::ZipError) -> AppError {
    AppError::InvalidArg(format!("zip: {e}"))
}

/// Text and JSON are worth compressing. Images and PDFs already are.
fn compressible(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".md", ".json", ".excalidraw", ".typ", ".txt"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// A ZIP entry name that cannot leave the extraction folder. Note titles end
/// up in these paths, and shared folders bring in titles other people chose.
fn archive_name(path: &str) -> AppResult<String> {
    let escapes = || AppError::InvalidArg(format!("Export path escapes the archive: {path}"));
    if path.contains('\\')
        || path
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
    {
        return Err(escapes());
    }
    // Rejects absolute paths and Windows drive prefixes as well.
    resolve_inside_root(Path::new(""), path).map_err(|_| escapes())?;
    Ok(path.to_string())
}

/// Stream a staged export or backup without holding it in memory. A plain
/// read/write loop, not `std::io::copy`, which may hand a file-to-file copy to
/// the kernel and bypass a document provider's write path.
pub(crate) fn stream_copy(source: &Path, output: &mut impl Write) -> AppResult<()> {
    let mut input = File::open(source)?;
    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read])?;
    }
    output.flush()?;
    Ok(())
}

/// Delete everything in the staging directory.
fn sweep_staging(staging: &Path) {
    let Ok(entries) = fs::read_dir(staging) else {
        return;
    };
    for entry in entries.flatten() {
        let _ = fs::remove_dir_all(entry.path());
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| CommandError::task(format!("Export task: {e}")))?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn export_begin<R: Runtime>(
    app: AppHandle<R>,
    target: ExportTarget,
) -> CommandResult<String> {
    let staging = match target {
        ExportTarget::Folder { .. } => None,
        _ => Some(crate::paths::app_data_dir(&app)?.join(STAGING_DIR)),
    };
    let token = uuid::Uuid::new_v4().to_string();
    let directory = staging.as_ref().map(|staging| staging.join(&token));
    let sweeper = app.clone();
    let session = blocking(move || {
        if let Some(staging) = &staging {
            sweeper.state::<ExportSessions>().sweep_once(staging);
        }
        match (target, directory) {
            (ExportTarget::Folder { root }, _) => Session::folder(PathBuf::from(root)),
            (ExportTarget::Archive, Some(directory)) => Session::staged(directory, true),
            (ExportTarget::File, Some(directory)) => Session::staged(directory, false),
            _ => Err(AppError::InvalidArg("Export staging is unavailable".into())),
        }
    })
    .await?;
    app.state::<ExportSessions>().insert(token.clone(), session);
    Ok(token)
}

/// Write one chunk. The body uses the binary file IPC format: JSON metadata,
/// then the chunk's bytes.
#[tauri::command]
pub async fn export_write<R: Runtime>(
    app: AppHandle<R>,
    request: Request<'_>,
) -> CommandResult<()> {
    let (metadata, bytes) = crate::assets::binary::decode::<WriteMetadata>(request.body())?;
    if bytes.len() > MAX_CHUNK_BYTES {
        return Err(AppError::InvalidArg("Export chunk is too large".into()).into());
    }
    let session = app.state::<ExportSessions>().get(&metadata.token)?;
    blocking(move || {
        let mut session = lock(&session);
        if metadata.first {
            session.start(&metadata.path, metadata.size)?;
        }
        session.append(&metadata.path, &bytes)
    })
    .await
}

/// Copy a stored asset into the export as `path`, so its bytes never pass
/// through the webview.
#[tauri::command]
pub async fn export_copy_asset<R: Runtime>(
    app: AppHandle<R>,
    token: String,
    path: String,
    asset_id: String,
    mime_type: Option<String>,
) -> CommandResult<()> {
    let session = app.state::<ExportSessions>().get(&token)?;
    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    blocking(move || {
        let _job = job;
        let asset = app
            .state::<Db>()
            .with_conn(|conn| crate::assets::load(conn, &asset_id))?;
        if mime_type.is_some_and(|mime| mime != asset.summary.mime_type) {
            return Err(AppError::InvalidArg(
                "Stored file has an unexpected type.".into(),
            ));
        }
        let mut session = lock(&session);
        session.start(&path, asset.bytes.len() as u64)?;
        session.append(&path, &asset.bytes)
    })
    .await
}

/// MIME types of stored assets, keyed by id. Missing ids are left out.
#[tauri::command]
pub async fn export_asset_types<R: Runtime>(
    app: AppHandle<R>,
    ids: Vec<String>,
) -> CommandResult<HashMap<String, String>> {
    if ids.len() > MAX_ASSET_IDS {
        return Err(AppError::InvalidArg("Too many assets in one request".into()).into());
    }
    blocking(move || {
        app.state::<Db>().with_conn(|conn| {
            Ok(ids
                .into_iter()
                .filter_map(|id| {
                    crate::assets::load_summary(conn, &id)
                        .ok()
                        .map(|summary| (id, summary.mime_type))
                })
                .collect())
        })
    })
    .await
}

/// Finish the export. A staged export asks where to save it first; `false`
/// means the user cancelled that dialog. Folder exports return `true`.
#[tauri::command]
pub async fn export_finish<R: Runtime>(
    app: AppHandle<R>,
    token: String,
    save: Option<SaveRequest>,
) -> CommandResult<bool> {
    finish_export(app, token, save, |app, save| async move {
        pick_destination(&app, &save).await
    })
    .await
}

/// [`export_finish`] with the destination picker passed in, so tests can
/// stand in for the native save dialog. `pick` resolves `None` on cancel.
#[doc(hidden)]
pub async fn finish_export<R, Pick, Picked>(
    app: AppHandle<R>,
    token: String,
    save: Option<SaveRequest>,
    pick: Pick,
) -> CommandResult<bool>
where
    R: Runtime,
    Pick: FnOnce(AppHandle<R>, SaveRequest) -> Picked,
    Picked: std::future::Future<Output = AppResult<Option<FilePath>>>,
{
    // Removed up front: whatever happens next, this session is over and its
    // staging directory goes with it.
    let session = app.state::<ExportSessions>().take(&token)?;
    let finishing = session.clone();
    let Some(staged) = blocking(move || {
        let staged = lock(&finishing).finish();
        staged
    })
    .await?
    else {
        return Ok(true);
    };
    let save = save.ok_or_else(|| AppError::InvalidArg("Missing save options".into()))?;
    save.validate()?;
    let Some(destination) = pick(app.clone(), save).await? else {
        return Ok(false);
    };
    blocking(move || {
        // Keep the session, and so its staged file, alive until the copy ends.
        let _session = session;
        save_to(&app, destination, &staged)
    })
    .await?;
    Ok(true)
}

/// Ask where to save a staged export. `None` means the user cancelled.
async fn pick_destination<R: Runtime>(
    app: &AppHandle<R>,
    save: &SaveRequest,
) -> AppResult<Option<FilePath>> {
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_title(save.dialog_title.as_deref().unwrap_or("Save export"))
        .add_filter(
            &save.filter_name,
            &save
                .extensions
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
        )
        .set_file_name(&save.suggested_name)
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    rx.await.map_err(|e| AppError::InvalidArg(e.to_string()))
}

/// Stream a staged export to the destination the user picked.
fn save_to<R: Runtime>(app: &AppHandle<R>, destination: FilePath, staged: &Path) -> AppResult<()> {
    let mut output = open_destination(app, destination)?;
    stream_copy(staged, &mut output)
}

#[cfg(target_os = "android")]
fn open_destination<R: Runtime>(app: &AppHandle<R>, destination: FilePath) -> AppResult<File> {
    use tauri_plugin_fs::FsExt;

    // A document-provider URI, not a path. The fs plugin opens it through
    // ContentResolver; "wt" truncates an existing document, unlike "w".
    let mut options = tauri_plugin_fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    Ok(app.fs().open(destination, options)?)
}

#[cfg(not(target_os = "android"))]
fn open_destination<R: Runtime>(_app: &AppHandle<R>, destination: FilePath) -> AppResult<File> {
    open_path(destination)
}

/// Open a picked filesystem path, replacing what is there. Desktop and iOS
/// dialogs return paths; a document-provider URI is refused.
#[cfg(not(target_os = "android"))]
fn open_path(destination: FilePath) -> AppResult<File> {
    let path = destination
        .into_path()
        .map_err(|e| AppError::InvalidArg(format!("path conversion: {e}")))?;
    Ok(File::create(path)?)
}

/// Drop an export that will not finish, with its staged files.
#[tauri::command]
pub fn export_abort<R: Runtime>(app: AppHandle<R>, token: String) -> CommandResult<()> {
    // An unknown token is fine: the export may already have ended.
    let _ = app.state::<ExportSessions>().take(&token);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn read_zip(path: &Path) -> Vec<(String, CompressionMethod, Vec<u8>)> {
        let mut archive = zip::ZipArchive::new(File::open(path).unwrap()).unwrap();
        (0..archive.len())
            .map(|i| {
                let mut entry = archive.by_index(i).unwrap();
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).unwrap();
                (entry.name().to_string(), entry.compression(), bytes)
            })
            .collect()
    }

    #[test]
    fn archive_joins_chunks_per_entry_and_compresses_only_text() {
        let staging = tempfile::tempdir().unwrap();
        let directory = staging.path().join("session");
        let mut session = Session::staged(directory.clone(), true).unwrap();
        session.start("Work/Note.md", 6).unwrap();
        session.append("Work/Note.md", b"# He").unwrap();
        session.append("Work/Note.md", b"y\n").unwrap();
        session.start("Work/_assets/a.png", 3).unwrap();
        session.append("Work/_assets/a.png", &[0, 255, 7]).unwrap();
        let staged = session.finish().unwrap().unwrap();

        assert_eq!(
            read_zip(&staged),
            vec![
                (
                    "Work/Note.md".into(),
                    CompressionMethod::Deflated,
                    b"# Hey\n".to_vec()
                ),
                (
                    "Work/_assets/a.png".into(),
                    CompressionMethod::Stored,
                    vec![0, 255, 7]
                ),
            ]
        );
        drop(session);
        assert!(
            !directory.exists(),
            "the staging directory goes with the session"
        );
    }

    #[test]
    fn archive_refuses_paths_that_leave_the_extraction_folder() {
        let staging = tempfile::tempdir().unwrap();
        let mut session = Session::staged(staging.path().join("s"), true).unwrap();
        for path in [
            "../x.md",
            "a/../../x.md",
            "/etc/x",
            "a\\b.md",
            "a//b.md",
            "./a.md",
            "",
        ] {
            assert!(session.start(path, 1).is_err(), "{path:?} was accepted");
        }
        #[cfg(windows)]
        assert!(session.start("C:/x.md", 1).is_err());
    }

    #[test]
    fn a_finished_archive_takes_no_more_files() {
        let staging = tempfile::tempdir().unwrap();
        let mut session = Session::staged(staging.path().join("s"), true).unwrap();
        session.start("a.md", 1).unwrap();
        session.finish().unwrap();
        let error = session.start("b.md", 1).unwrap_err();
        assert!(error.to_string().contains("already finished"), "{error}");
        assert!(session.finish().is_err());
    }

    #[test]
    fn chunks_must_follow_their_open_file() {
        let staging = tempfile::tempdir().unwrap();
        let mut session = Session::staged(staging.path().join("s"), true).unwrap();
        assert!(session.append("a.md", b"x").is_err(), "nothing is open yet");
        session.start("a.md", 1).unwrap();
        assert!(
            session.append("b.md", b"x").is_err(),
            "b.md is not the open file"
        );
    }

    #[test]
    fn folder_writes_nested_files_and_refuses_traversal() {
        let root = tempfile::tempdir().unwrap();
        let mut session = Session::folder(root.path().to_path_buf()).unwrap();
        session.start("a/b/Note.md", 5).unwrap();
        session.append("a/b/Note.md", b"he").unwrap();
        session.append("a/b/Note.md", b"llo").unwrap();
        assert!(session.start("../escape.md", 1).is_err());
        assert_eq!(session.finish().unwrap(), None);
        assert_eq!(fs::read(root.path().join("a/b/Note.md")).unwrap(), b"hello");
        assert!(!root.path().parent().unwrap().join("escape.md").exists());
    }

    #[test]
    fn folder_target_must_exist() {
        let root = tempfile::tempdir().unwrap();
        assert!(Session::folder(root.path().join("missing")).is_err());
    }

    #[test]
    fn single_file_target_holds_exactly_one_file() {
        let staging = tempfile::tempdir().unwrap();
        let mut empty = Session::staged(staging.path().join("empty"), false).unwrap();
        assert!(
            empty.finish().is_err(),
            "an empty single-file export is an error"
        );

        let mut session = Session::staged(staging.path().join("one"), false).unwrap();
        session.start("Note.pdf", 4).unwrap();
        session.append("Note.pdf", b"%PDF").unwrap();
        assert!(session.start("Other.pdf", 1).is_err());
        let staged = session.finish().unwrap().unwrap();
        assert_eq!(fs::read(staged).unwrap(), b"%PDF");
    }

    #[test]
    fn stream_copy_moves_every_byte_and_reports_write_failures() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("export.zip");
        let bytes: Vec<u8> = (0..(COPY_BUFFER_BYTES * 2 + 17))
            .map(|i| (i * 31 + 7) as u8)
            .collect();
        fs::write(&source, &bytes).unwrap();
        let mut output = Vec::new();
        stream_copy(&source, &mut output).unwrap();
        assert_eq!(output, bytes);
        assert!(stream_copy(&source, &mut Cursor::new(&mut [0u8; 4][..])).is_err());
    }

    #[test]
    fn only_the_first_sweep_of_a_run_clears_staging() {
        let staging = tempfile::tempdir().unwrap();
        let stale = staging.path().join("stale");
        fs::create_dir_all(&stale).unwrap();
        let sessions = ExportSessions::default();
        sessions.sweep_once(staging.path());
        assert!(!stale.exists());

        // A later export must not touch this run's sessions, even one that is
        // no longer registered because it is finishing.
        let finishing = staging.path().join("finishing");
        fs::create_dir_all(&finishing).unwrap();
        sessions.sweep_once(staging.path());
        assert!(finishing.exists());
    }

    #[test]
    fn dropping_an_unfinished_staged_export_deletes_its_files() {
        let staging = tempfile::tempdir().unwrap();
        for archive in [true, false] {
            let directory = staging.path().join(format!("open-{archive}"));
            let mut session = Session::staged(directory.clone(), archive).unwrap();
            session.start("Note.md", 4).unwrap();
            session.append("Note.md", b"half").unwrap();
            drop(session);
            assert!(!directory.exists(), "archive={archive}");
        }
    }

    // No mock app here: on Windows it makes this test binary unloadable.
    #[cfg(not(target_os = "android"))]
    #[test]
    fn a_staged_export_is_copied_to_a_picked_path_and_replaces_it() {
        let directory = tempfile::tempdir().unwrap();
        let staged = directory.path().join("export.zip");
        fs::write(&staged, b"PK new archive").unwrap();
        let destination = directory.path().join("picked.zip");
        fs::write(&destination, b"an older and longer file").unwrap();
        let mut output = open_path(FilePath::Path(destination.clone())).unwrap();
        stream_copy(&staged, &mut output).unwrap();
        drop(output);
        assert_eq!(fs::read(&destination).unwrap(), b"PK new archive");

        let url = tauri::Url::parse("content://provider/document/1").unwrap();
        assert!(open_path(FilePath::Url(url)).is_err());
    }

    #[test]
    fn save_filter_is_validated() {
        let mut save = SaveRequest {
            suggested_name: "x.zip".into(),
            dialog_title: None,
            filter_name: "ZIP archive".into(),
            extensions: vec!["zip".into()],
        };
        assert!(save.validate().is_ok());
        save.extensions = vec!["z.ip".into()];
        assert!(save.validate().is_err());
    }
}
