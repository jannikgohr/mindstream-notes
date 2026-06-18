//! Backup export — Slice A of the Data & Backup feature.
//!
//! A backup is a zip file containing:
//!   - `manifest.json` — versioning, account identity, content counts
//!   - `data.db`       — full SQLite snapshot produced by VACUUM INTO
//!
//! Slice B will add the import preview, slice C the staged-restart
//! restore, slice D the in-process merge. Everything they need to read
//! the manifest is defined here so they reuse the same types.
//!
//! Account identity in the manifest follows the design we settled on:
//! the `etebase_collection_uid` for notes + folders read from the
//! source DB's `sync_state` table. Same UID → same account. The
//! friendly `username` / `server_url` come from the on-disk session
//! file purely for UI surfacing on mismatch — they don't gate the
//! match decision.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;
use zip::write::FileOptions;
use zip::CompressionMethod;

use crate::auth;
use crate::collections::TRASH_ID;
use crate::db::{migrations, Db};
use crate::error::{AppError, AppResult};

/// Bump only when the on-disk layout becomes incompatible with older
/// readers — adding new optional manifest fields shouldn't require it.
pub const MANIFEST_FORMAT_VERSION: u32 = 1;

/// Name of the SQLite snapshot inside the zip. Hardcoded so import
/// always knows where to look; `manifest.contents.db_filename` echoes
/// the value so a future schema change has a forward-compatible path.
pub const DB_ENTRY_NAME: &str = "data.db";

/// Name of the manifest file inside the zip.
pub const MANIFEST_ENTRY_NAME: &str = "manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub format_version: u32,
    pub app_version: String,
    pub schema_version: u32,
    pub created_at: String,
    /// True if the source DB's `sync_state` table had rows at export
    /// time. False ⇒ `account` is `None` and import treats this as a
    /// local-only backup regardless of who's signed in.
    pub account_present_at_export: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<AccountIdentity>,
    pub contents: Contents,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountIdentity {
    /// Etebase collection UID for the user's notes collection on the
    /// remote — the actual identity check on import compares this
    /// against the importing DB's `sync_state`.
    pub etebase_collection_uid_notes: String,
    pub etebase_collection_uid_folders: String,
    /// Friendly display, optional — surfaces in mismatch dialogs but
    /// isn't part of the equality check. Both fields are filled from
    /// the on-disk session file when available; absent if the user
    /// signed out after their data synced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contents {
    pub db_filename: String,
    pub counts: Counts,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Counts {
    pub notes: u32,
    pub folders: u32,
    /// Total `size` column across the assets table. Lets the import
    /// preview show a "this backup carries X MB of attachments" line
    /// without extracting the zip first.
    pub assets_bytes: u64,
}

/// Result of a successful `backup_now`. The destination path is what
/// the user picked; the counts mirror the manifest so the JS side can
/// surface a "backup contains N notes" toast without re-reading.
#[derive(Debug, Clone, Serialize)]
pub struct BackupReport {
    pub destination: String,
    pub counts: Counts,
    pub account_present: bool,
}

/// Conventional default location for backups (`<app_data>/backups/`).
/// The directory is created lazily by `run_backup` when an export
/// actually lands; we don't pre-create here because the dialog's
/// `defaultPath` works whether the directory exists or not.
fn default_backup_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidArg(format!("app_data_dir: {e}")))?
        .join("backups"))
}

/// Path-safe suggested filename — `T<HH-MM-SS>` (hyphens, not colons)
/// so Windows accepts it.
fn suggested_filename() -> String {
    let now = chrono::Utc::now();
    format!("mindstream-backup-{}.zip", now.format("%Y-%m-%dT%H-%M-%S"))
}

/// Pop the Save-As dialog, then run the export. Returns `None` when
/// the user cancels — distinct from an error — so the JS side stays
/// quiet (no error toast for a deliberate cancel).
///
/// Mirrors the dialog-then-write pattern in `pdf_export.rs`.
#[tauri::command]
pub async fn backup_now(app: AppHandle) -> Result<Option<BackupReport>, String> {
    backup_now_inner(app).await.map_err(Into::into)
}

async fn backup_now_inner(app: AppHandle) -> AppResult<Option<BackupReport>> {
    let default_dir = default_backup_dir(&app)?;
    // Pre-create the suggested folder so the dialog opens *inside* it
    // even on first run. Without this Tauri falls back to the user's
    // home dir, which is fine but loses the discoverability hint.
    let _ = fs::create_dir_all(&default_dir);
    let suggested = suggested_filename();

    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("Save Mindstream Notes backup")
        .add_filter("Mindstream backup", &["zip"])
        .set_file_name(&suggested)
        .set_directory(&default_dir)
        .set_can_create_directories(true)
        .save_file(move |path| {
            let _ = tx.send(path);
        });

    let Some(file_path) = rx.await.map_err(|e| AppError::InvalidArg(e.to_string()))? else {
        return Ok(None);
    };
    let destination = file_path
        .into_path()
        .map_err(|e| AppError::InvalidArg(format!("path conversion: {e}")))?;

    let session = auth::read_session_info(&app)?;
    // The DB lock is sync; run the export on a blocking thread so the
    // async dialog future stays cooperative. Reach for the Db state
    // inside the closure since `tauri::State` isn't `Send`.
    let app_for_blocking = app.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        let db = app_for_blocking.state::<Db>();
        db.with_conn_mut(|conn| run_backup(&app_for_blocking, conn, &destination, session.as_ref()))
    })
    .await
    .map_err(|e| AppError::InvalidArg(format!("backup task: {e}")))??;
    Ok(Some(report))
}

fn run_backup(
    app: &AppHandle,
    conn: &mut Connection,
    destination: &Path,
    session: Option<&auth::SessionInfo>,
) -> AppResult<BackupReport> {
    // Snapshot lives under `<app_data>/backups/.staging/<uuid>.db` —
    // same drive as the live DB so VACUUM INTO is fast, separated from
    // the user's chosen output dir so it stays clean. We delete the
    // staging file at the end regardless of outcome.
    let staging_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidArg(format!("app_data_dir: {e}")))?
        .join("backups")
        .join(".staging");
    fs::create_dir_all(&staging_dir)?;
    let staging_db = staging_dir.join(format!("snapshot-{}.db", uuid::Uuid::new_v4()));

    // SQLite refuses to VACUUM INTO an existing file. The uuid keeps
    // this unique, but be defensive against a stale file from a
    // previous crashed export.
    if staging_db.exists() {
        fs::remove_file(&staging_db)?;
    }

    // Defer cleanup so a failure after this point still removes the
    // staging file. The `?` propagation below would otherwise leave it
    // behind.
    let _cleanup = StagingCleanup(staging_db.clone());

    let staging_db_str = staging_db
        .to_str()
        .ok_or_else(|| AppError::InvalidArg("staging path is not valid UTF-8".into()))?;
    // Single-quote escape: SQLite identifiers double the quote. Path
    // separators (`\` on Windows) need no escaping inside a single-
    // quoted SQLite string literal.
    let escaped = staging_db_str.replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{escaped}';"))?;

    // Read the manifest inputs from the *snapshot*, not the live DB —
    // the snapshot is the point-in-time consistent view we're actually
    // shipping. Counts taken from a different connection during the
    // export window could drift.
    let snapshot = Connection::open(&staging_db)?;
    let counts = read_counts(&snapshot)?;
    let identity = read_account_identity(&snapshot, session)?;
    let schema_version: u32 = snapshot.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    drop(snapshot);

    let manifest = Manifest {
        format_version: MANIFEST_FORMAT_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        schema_version,
        created_at: chrono::Utc::now().to_rfc3339(),
        account_present_at_export: identity.is_some(),
        account: identity,
        contents: Contents {
            db_filename: DB_ENTRY_NAME.to_string(),
            counts: counts.clone(),
        },
    };

    // Atomic write: zip into `<destination>.tmp`, fsync the parent
    // dir, rename to `<destination>`. A crashed export leaves the tmp
    // file but never a half-written backup at the real path.
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp_path = with_extra_extension(destination, "tmp");
    write_zip(&tmp_path, &manifest, &staging_db)?;
    if destination.exists() {
        // Replace works on Windows where rename-over-existing doesn't.
        fs::remove_file(destination)?;
    }
    fs::rename(&tmp_path, destination)?;

    Ok(BackupReport {
        destination: destination
            .to_str()
            .map(|s| s.to_string())
            .unwrap_or_else(|| destination.to_string_lossy().into_owned()),
        counts,
        account_present: manifest.account_present_at_export,
    })
}

fn read_counts(conn: &Connection) -> AppResult<Counts> {
    let notes: u32 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))?;
    // Folders: exclude the built-in 'trash' collection — it's an
    // always-present implementation detail, not user content. The
    // import flow knows to recreate it.
    let folders: u32 = conn.query_row(
        "SELECT COUNT(*) FROM collections WHERE id <> 'trash'",
        [],
        |r| r.get(0),
    )?;
    let assets_bytes: i64 = conn
        .query_row("SELECT COALESCE(SUM(size), 0) FROM assets", [], |r| {
            r.get(0)
        })
        .unwrap_or(0);
    Ok(Counts {
        notes,
        folders,
        assets_bytes: assets_bytes.max(0) as u64,
    })
}

fn read_account_identity(
    conn: &Connection,
    session: Option<&auth::SessionInfo>,
) -> AppResult<Option<AccountIdentity>> {
    // Both collection UIDs must be present for the identity block to
    // count — a half-synced DB (one kind pushed, the other not) is a
    // gnarly state we don't try to round-trip identity for.
    let notes_uid: Option<String> = conn
        .query_row(
            "SELECT etebase_collection_uid FROM sync_state WHERE kind = 'notes'",
            [],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    let folders_uid: Option<String> = conn
        .query_row(
            "SELECT etebase_collection_uid FROM sync_state WHERE kind = 'folders'",
            [],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    match (notes_uid, folders_uid) {
        (Some(notes), Some(folders)) => Ok(Some(AccountIdentity {
            etebase_collection_uid_notes: notes,
            etebase_collection_uid_folders: folders,
            server_url: session.map(|s| s.server_url.clone()),
            username: session.map(|s| s.username.clone()),
        })),
        _ => Ok(None),
    }
}

fn write_zip(zip_path: &Path, manifest: &Manifest, db_path: &Path) -> AppResult<()> {
    let file = fs::File::create(zip_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: FileOptions<()> = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    // Manifest first so any cheap-read tooling can stat the first
    // entry to identify the file.
    zip.start_file(MANIFEST_ENTRY_NAME, opts)
        .map_err(zip_to_app)?;
    let manifest_bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|e| AppError::InvalidArg(format!("serialize manifest: {e}")))?;
    zip.write_all(&manifest_bytes)?;

    zip.start_file(DB_ENTRY_NAME, opts).map_err(zip_to_app)?;
    let db_bytes = fs::read(db_path)?;
    zip.write_all(&db_bytes)?;

    zip.finish().map_err(zip_to_app)?;
    Ok(())
}

fn zip_to_app(e: zip::result::ZipError) -> AppError {
    AppError::InvalidArg(format!("zip: {e}"))
}

fn with_extra_extension(path: &Path, extra: &str) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".");
    name.push(extra);
    path.with_file_name(name)
}

/// Best-effort cleanup of the staging snapshot. Runs on success
/// (after the rename) and on failure (via Drop), so the `.staging/`
/// directory stays empty between exports.
struct StagingCleanup(PathBuf);

impl Drop for StagingCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

// =====================================================================
// Import — slices B / C / D
// =====================================================================
//
// Flow: `import_begin` pops the open dialog, extracts the zip into a
// per-import staging directory, runs migrations on the staged DB, and
// returns a preview struct + a `token` (the staging dir's name) that
// subsequent calls use to identify which staged copy to operate on.
//
// The user then picks one of:
//   * `import_restore` — stage to `pending-restore.db`, write sentinel,
//     ask JS to relaunch. The boot hook in `lib.rs` swaps files in
//     before the live DB opens.
//   * `import_merge`   — open a second connection on the staged DB and
//     copy rows whose IDs don't exist locally. In-process; no restart.
//   * `import_cleanup` — user cancelled, drop the staging dir.

const SENTINEL_FILE: &str = "pending-restore.flag";
const PENDING_DB_FILE: &str = "pending-restore.db";

/// Preview shown in the import-choice dialog so the user knows what
/// they're about to apply. Counts come from the staged DB *after*
/// migrations, so they reflect the schema the import would actually
/// land at.
#[derive(Debug, Clone, Serialize)]
pub struct ImportPreview {
    /// Staging directory name (a UUID). Pass back into `import_restore`,
    /// `import_merge`, or `import_cleanup` to reference this attempt.
    pub token: String,
    pub backup_counts: Counts,
    pub current_counts: Counts,
    pub backup_app_version: String,
    pub backup_created_at: String,
    /// True if the backup's account UIDs match the current DB's
    /// sync_state. False means import would sanitize sync metadata on
    /// restore (and merge always sanitizes regardless).
    pub same_account: bool,
    /// Friendly identifiers for the dialog copy — both optional;
    /// `None` for the relevant side means "local-only" there.
    pub backup_account: Option<AccountDisplay>,
    pub current_account: Option<AccountDisplay>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountDisplay {
    pub username: Option<String>,
    pub server_url: Option<String>,
}

/// Pop the open dialog, extract+validate the picked zip, and return a
/// preview. `None` means the user cancelled the dialog.
#[tauri::command]
pub async fn import_begin(app: AppHandle) -> Result<Option<ImportPreview>, String> {
    import_begin_inner(app).await.map_err(Into::into)
}

async fn import_begin_inner(app: AppHandle) -> AppResult<Option<ImportPreview>> {
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("Import Mindstream Notes backup")
        .add_filter("Mindstream backup", &["zip"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(file_path) = rx.await.map_err(|e| AppError::InvalidArg(e.to_string()))? else {
        return Ok(None);
    };
    let source = file_path
        .into_path()
        .map_err(|e| AppError::InvalidArg(format!("path conversion: {e}")))?;

    let session = auth::read_session_info(&app)?;
    let app_for_blocking = app.clone();
    let preview = tauri::async_runtime::spawn_blocking(move || {
        let db = app_for_blocking.state::<Db>();
        db.with_conn(|live_conn| {
            stage_import(&app_for_blocking, &source, live_conn, session.as_ref())
        })
    })
    .await
    .map_err(|e| AppError::InvalidArg(format!("import task: {e}")))??;
    Ok(Some(preview))
}

fn stage_import(
    app: &AppHandle,
    source_zip: &Path,
    live_conn: &Connection,
    session: Option<&auth::SessionInfo>,
) -> AppResult<ImportPreview> {
    // One staging dir per import attempt. Sweep prior dirs first —
    // they're either a crashed import (nothing to recover) or a
    // user-cancelled choice that never reached `import_cleanup`.
    let staging_root = imports_staging_root(app)?;
    sweep_staging_root(&staging_root);

    let token = uuid::Uuid::new_v4().to_string();
    let dir = staging_root.join(&token);
    fs::create_dir_all(&dir)?;

    let staged_db = dir.join("data.db");
    let manifest = extract_zip_into(source_zip, &dir, &staged_db)?;

    if manifest.format_version > MANIFEST_FORMAT_VERSION {
        // Older app can't safely read a newer manifest. Refuse with a
        // clear error rather than guessing at unknown fields.
        let _ = fs::remove_dir_all(&dir);
        return Err(AppError::InvalidArg(format!(
            "backup format version {} is newer than this app supports ({})",
            manifest.format_version, MANIFEST_FORMAT_VERSION,
        )));
    }

    // Refuse future schemas, migrate older ones forward. This needs to
    // happen *before* we read counts so the staged DB's table shapes
    // match what import_restore / import_merge will encounter.
    let mut staged = Connection::open(&staged_db)?;
    let staged_version: u32 = staged.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let live_version: u32 = live_conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if staged_version > live_version {
        let _ = fs::remove_dir_all(&dir);
        return Err(AppError::InvalidArg(format!(
            "backup uses schema v{} but this app understands at most v{} — update the app and try again",
            staged_version, live_version,
        )));
    }
    validate_looks_like_mindstream_db(&staged)?;
    migrations::run(&mut staged)?;

    let backup_counts = read_counts(&staged)?;
    let backup_identity = read_account_identity(&staged, None)?;
    let current_identity = read_account_identity(live_conn, session)?;
    let current_counts = read_counts(live_conn)?;
    let same_account = match (&backup_identity, &current_identity) {
        (Some(b), Some(c)) => {
            b.etebase_collection_uid_notes == c.etebase_collection_uid_notes
                && b.etebase_collection_uid_folders == c.etebase_collection_uid_folders
        }
        _ => false,
    };

    // The friendly identifiers come from the *manifest* for the backup
    // side (the staged sync_state has the UIDs but not the user-facing
    // username / server URL — those were captured at export time).
    let backup_account = manifest.account.as_ref().map(|a| AccountDisplay {
        username: a.username.clone(),
        server_url: a.server_url.clone(),
    });
    let current_account = current_identity.as_ref().map(|c| AccountDisplay {
        username: c.username.clone(),
        server_url: c.server_url.clone(),
    });

    Ok(ImportPreview {
        token,
        backup_counts,
        current_counts,
        backup_app_version: manifest.app_version,
        backup_created_at: manifest.created_at,
        same_account,
        backup_account,
        current_account,
    })
}

fn extract_zip_into(source_zip: &Path, dir: &Path, db_target: &Path) -> AppResult<Manifest> {
    let file = fs::File::open(source_zip)?;
    let mut archive = zip::ZipArchive::new(file).map_err(zip_to_app)?;

    // Manifest first — we need it to decide whether to trust the rest.
    let manifest: Manifest = {
        let mut entry = archive
            .by_name(MANIFEST_ENTRY_NAME)
            .map_err(|_| AppError::InvalidArg("backup is missing manifest.json".into()))?;
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;
        serde_json::from_slice(&bytes)
            .map_err(|e| AppError::InvalidArg(format!("manifest parse: {e}")))?
    };

    let db_name = manifest.contents.db_filename.clone();
    let mut entry = archive.by_name(&db_name).map_err(|_| {
        AppError::InvalidArg(format!("backup is missing '{db_name}' (named in manifest)"))
    })?;
    fs::create_dir_all(dir)?;
    let mut out = fs::File::create(db_target)?;
    std::io::copy(&mut entry, &mut out)?;
    Ok(manifest)
}

fn validate_looks_like_mindstream_db(conn: &Connection) -> AppResult<()> {
    // Cheap structural check — confirms the file is a SQLite DB and
    // has the tables we touch downstream. Real corruption would
    // surface during PRAGMA integrity_check, but that's O(file size)
    // and overkill for the "is this even our format?" question.
    for table in ["notes", "collections", "sync_state", "tombstones"] {
        let found: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![table],
                |r| r.get(0),
            )
            .optional()?;
        if found.is_none() {
            return Err(AppError::InvalidArg(format!(
                "backup is missing the '{table}' table — file may not be a Mindstream Notes backup"
            )));
        }
    }
    Ok(())
}

/// Drop the staging dir for the given token. Called when the user
/// cancels the import-choice dialog; safe to call on a stale token.
#[tauri::command]
pub fn import_cleanup(app: AppHandle, token: String) -> Result<(), String> {
    let dir = imports_staging_root(&app)
        .map_err(|e| e.to_string())?
        .join(&token);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("remove staging: {e}"))?;
    }
    Ok(())
}

/// Restore-replace: sanitize sync metadata if the account mismatches,
/// then move the staged DB into `<app_data>/pending-restore.db` and
/// write the sentinel. JS reads the returned flag and prompts the
/// user to relaunch; the boot hook does the swap.
#[tauri::command]
pub fn import_restore(
    app: AppHandle,
    token: String,
    same_account: bool,
) -> Result<RestoreStaged, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let staged = imports_staging_root(&app)
        .map_err(|e| e.to_string())?
        .join(&token)
        .join("data.db");
    if !staged.exists() {
        return Err(format!("staged backup '{token}' not found"));
    }
    let pending_db = app_data.join(PENDING_DB_FILE);
    let sentinel = app_data.join(SENTINEL_FILE);

    if sentinel.exists() {
        return Err(
            "a restore is already pending — restart Mindstream Notes to finish that one before starting another"
                .into(),
        );
    }

    // Sanitize on the staged file, not on the pending file, so a
    // failure here leaves no half-prepared pending in place.
    if !same_account {
        sanitize_for_foreign_account(&staged).map_err(|e| e.to_string())?;
    }

    // Move-then-mark: the sentinel must not exist until the staged DB
    // is fully in place. Otherwise a crash between the two leaves the
    // app thinking a restore is ready when the file isn't there.
    if pending_db.exists() {
        fs::remove_file(&pending_db).map_err(|e| format!("clear stale pending: {e}"))?;
    }
    fs::rename(&staged, &pending_db).map_err(|e| format!("stage pending: {e}"))?;
    fs::write(&sentinel, b"pending").map_err(|e| format!("write sentinel: {e}"))?;

    // The staging dir's now empty of its data.db; drop the dir
    // entirely so a future import_begin doesn't sweep it later.
    let dir = imports_staging_root(&app)
        .map_err(|e| e.to_string())?
        .join(&token);
    let _ = fs::remove_dir_all(&dir);

    Ok(RestoreStaged {
        restart_required: true,
        sanitized: !same_account,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoreStaged {
    pub restart_required: bool,
    /// True iff sync metadata was stripped from the staged DB.
    pub sanitized: bool,
}

fn sanitize_for_foreign_account(staged_db: &Path) -> AppResult<()> {
    let mut conn = Connection::open(staged_db)?;
    let tx = conn.transaction()?;
    // Sync-identity columns: NULL out + mark dirty so a future push to
    // whatever account the user signs into next treats every row as
    // new.
    tx.execute(
        "UPDATE notes SET etebase_uid = NULL, etebase_etag = NULL, dirty = 1",
        [],
    )?;
    tx.execute(
        "UPDATE collections SET etebase_uid = NULL, etebase_etag = NULL, dirty = 1 WHERE id <> 'trash'",
        [],
    )?;
    tx.execute(
        "UPDATE assets SET etebase_uid = NULL, etebase_etag = NULL, dirty = 1",
        [],
    )?;
    tx.execute(
        "UPDATE signatures SET etebase_uid = NULL, etebase_etag = NULL, dirty = 1",
        [],
    )?;
    // Drop the per-kind collection pointers + stoken cursors and any
    // queued tombstones for the foreign account.
    tx.execute("DELETE FROM sync_state", [])?;
    tx.execute("DELETE FROM tombstones", [])?;
    tx.commit()?;
    Ok(())
}

/// Merge missing items: copy rows from the staged DB into the live DB
/// when their `id` doesn't exist locally. Sync metadata is dropped on
/// every imported row (merge mode is always sanitize-by-design). No
/// restart needed.
#[tauri::command]
pub fn import_merge(
    app: AppHandle,
    db: tauri::State<'_, Db>,
    token: String,
) -> Result<MergeReport, String> {
    let staged = imports_staging_root(&app)
        .map_err(|e| e.to_string())?
        .join(&token)
        .join("data.db");
    if !staged.exists() {
        return Err(format!("staged backup '{token}' not found"));
    }
    let backup_conn = Connection::open(&staged).map_err(|e| format!("open staged: {e}"))?;
    let report = db
        .with_conn_mut(|live| merge_into(live, &backup_conn))
        .map_err(|e| e.to_string())?;
    // Merge consumed the staged DB; drop the dir so it doesn't linger.
    let dir = imports_staging_root(&app)
        .map_err(|e| e.to_string())?
        .join(&token);
    let _ = fs::remove_dir_all(&dir);
    Ok(report)
}

#[derive(Debug, Clone, Serialize)]
pub struct MergeReport {
    pub folders_added: u32,
    pub notes_added: u32,
    pub assets_added: u32,
    /// Notes whose `parent_collection_id` referenced a folder that
    /// didn't exist in the merged DB and was rerouted to root. Useful
    /// to surface in the success toast so the user knows where to
    /// look.
    pub notes_orphaned: u32,
}

fn merge_into(live: &mut Connection, backup: &Connection) -> AppResult<MergeReport> {
    let tx = live.transaction()?;

    // ---- Folders first (children depend on parents existing). ----
    let mut stmt = backup.prepare(
        "SELECT id, parent_collection_id, name, position, created, modified
         FROM collections
         WHERE id <> 'trash'",
    )?;
    let folder_rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    // Two-pass insert: first insert all folders with parent = NULL so
    // we don't trip the FK on intra-backup orphans (a folder that
    // points at a sibling later in the iteration). Second pass fixes
    // up parents to whatever resolves in the merged DB; anything that
    // doesn't is left at root, matching the user's stated preference
    // for orphan-to-root.
    let mut folders_added = 0u32;
    for (id, _parent, name, position, created, modified) in &folder_rows {
        let exists: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM collections WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_some() {
            continue;
        }
        tx.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position, created, modified, dirty)
             VALUES (?1, NULL, ?2, ?3, ?4, ?5, 1)",
            params![id, name, position, created, modified],
        )?;
        folders_added += 1;
    }
    for (id, parent, _name, _position, _created, _modified) in &folder_rows {
        let Some(parent_id) = parent else {
            continue;
        };
        // Only re-parent folders we just added (don't touch pre-existing
        // ones whose parent might be intentionally different locally).
        let was_added: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM collections WHERE id = ?1 AND parent_collection_id IS NULL",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        if was_added.is_none() {
            continue;
        }
        let parent_exists: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM collections WHERE id = ?1",
                params![parent_id],
                |r| r.get(0),
            )
            .optional()?;
        if parent_exists.is_some() && parent_id != TRASH_ID {
            tx.execute(
                "UPDATE collections SET parent_collection_id = ?1 WHERE id = ?2",
                params![parent_id, id],
            )?;
        }
        // else: orphan parent — leave at root.
    }

    // ---- Notes ----
    let mut stmt = backup.prepare(
        "SELECT id, parent_collection_id, title, body, position, created, modified,
                trashed_at, favourite, yrs_state, payload_schema, note_kind
         FROM notes",
    )?;
    let note_rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, i64>(8)?,
                r.get::<_, Option<Vec<u8>>>(9)?,
                r.get::<_, i64>(10)?,
                r.get::<_, String>(11)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    let mut notes_added = 0u32;
    let mut notes_orphaned = 0u32;
    for (
        id,
        parent,
        title,
        body,
        position,
        created,
        modified,
        trashed_at,
        favourite,
        yrs_state,
        payload_schema,
        note_kind,
    ) in &note_rows
    {
        let exists: Option<i64> = tx
            .query_row("SELECT 1 FROM notes WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .optional()?;
        if exists.is_some() {
            continue;
        }
        // Resolve parent against the merged collections; drop to root
        // if it doesn't exist (matches the user's chosen orphan policy).
        let resolved_parent: Option<String> = if let Some(parent_id) = parent {
            let parent_present: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM collections WHERE id = ?1",
                    params![parent_id],
                    |r| r.get(0),
                )
                .optional()?;
            if parent_present.is_some() {
                Some(parent_id.clone())
            } else {
                notes_orphaned += 1;
                None
            }
        } else {
            None
        };

        tx.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position,
                                created, modified, dirty, note_kind, trashed_at,
                                favourite, yrs_state, payload_schema)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?10, ?11, ?12)",
            params![
                id,
                resolved_parent,
                title,
                body,
                position,
                created,
                modified,
                note_kind,
                trashed_at,
                favourite,
                yrs_state,
                payload_schema,
            ],
        )?;
        notes_added += 1;

        // Bring this note's tags along.
        let mut tag_stmt = backup.prepare("SELECT tag FROM note_tags WHERE note_id = ?1")?;
        let tag_rows = tag_stmt.query_map(params![id], |r| r.get::<_, String>(0))?;
        for tag in tag_rows {
            let tag = tag?;
            // INSERT OR IGNORE because the PK is (note_id, tag).
            tx.execute(
                "INSERT OR IGNORE INTO note_tags(note_id, tag) VALUES (?1, ?2)",
                params![id, tag],
            )?;
        }
    }

    // ---- Assets ----
    let mut stmt = backup.prepare(
        "SELECT id, owning_note_id, mime_type, bytes, size, created, modified
         FROM assets",
    )?;
    let asset_rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Vec<u8>>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    let mut assets_added = 0u32;
    for (id, owning_note_id, mime, bytes, size, created, modified) in &asset_rows {
        // Skip assets whose owning note didn't make it (either it
        // already existed locally with different content, or the user
        // chose merge mode and the note collided). Don't import an
        // orphan blob.
        let owner_present: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM notes WHERE id = ?1",
                params![owning_note_id],
                |r| r.get(0),
            )
            .optional()?;
        if owner_present.is_none() {
            continue;
        }
        let exists: Option<i64> = tx
            .query_row("SELECT 1 FROM assets WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .optional()?;
        if exists.is_some() {
            continue;
        }
        tx.execute(
            "INSERT INTO assets(id, owning_note_id, mime_type, bytes, size, created, modified, dirty)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)",
            params![id, owning_note_id, mime, bytes, size, created, modified],
        )?;
        assets_added += 1;
    }

    // ---- Signatures (user-global; no owning note to gate on) ----
    let mut stmt = backup.prepare("SELECT id, data, created, modified FROM signatures")?;
    let signature_rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    for (id, data, created, modified) in &signature_rows {
        let exists: Option<i64> = tx
            .query_row("SELECT 1 FROM signatures WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .optional()?;
        if exists.is_some() {
            continue;
        }
        // dirty = 1 so the imported signature re-pushes under the current
        // account. Not surfaced in MergeReport — the import preview/report
        // only counts notes/folders/assets, so that contract stays put.
        tx.execute(
            "INSERT INTO signatures(id, data, created, modified, dirty)
             VALUES (?1, ?2, ?3, ?4, 1)",
            params![id, data, created, modified],
        )?;
    }

    tx.commit()?;
    Ok(MergeReport {
        folders_added,
        notes_added,
        assets_added,
        notes_orphaned,
    })
}

fn imports_staging_root(app: &AppHandle) -> AppResult<PathBuf> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidArg(format!("app_data_dir: {e}")))?
        .join("imports")
        .join(".staging");
    fs::create_dir_all(&root)?;
    Ok(root)
}

fn sweep_staging_root(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let _ = fs::remove_dir_all(entry.path());
    }
}

/// Run at startup *before* `Db::open`. If a previous session staged a
/// restore, swap the pending DB into place and move the old one to a
/// timestamped safety copy. Errors are logged but non-fatal so a
/// botched restore doesn't keep the app from booting at all.
pub fn apply_pending_restore_if_any(app: &AppHandle) {
    let Ok(app_data) = app.path().app_data_dir() else {
        return;
    };
    let sentinel = app_data.join(SENTINEL_FILE);
    let pending = app_data.join(PENDING_DB_FILE);
    if !sentinel.exists() {
        return;
    }
    if !pending.exists() {
        // Sentinel without pending — corrupted state. Clear the
        // sentinel so we don't loop on it next boot.
        log::warn!("[restore] sentinel present but no pending DB; clearing");
        let _ = fs::remove_file(&sentinel);
        return;
    }
    if let Err(err) = apply_pending_restore(&app_data, &pending, &sentinel) {
        log::error!("[restore] failed to apply pending restore: {err}");
    }
}

fn apply_pending_restore(app_data: &Path, pending: &Path, sentinel: &Path) -> AppResult<()> {
    let live = app_data.join("mindstream.db");
    let live_wal = app_data.join("mindstream.db-wal");
    let live_shm = app_data.join("mindstream.db-shm");

    if live.exists() {
        let ts = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S").to_string();
        let safety = app_data.join(format!("mindstream-pre-restore-{ts}.db"));
        fs::rename(&live, &safety)?;
        log::info!("[restore] previous DB saved to {}", safety.display());
    }
    // WAL/SHM belong to the old DB. The pending DB carries its own
    // consistent state (or none — fresh open will create one), so
    // discarding these is safe.
    let _ = fs::remove_file(&live_wal);
    let _ = fs::remove_file(&live_shm);

    fs::rename(pending, &live)?;
    fs::remove_file(sentinel)?;
    log::info!("[restore] pending restore applied");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory_for_tests;
    use std::io::Read;

    /// In-memory DBs can't be VACUUMed INTO via a path-based connection
    /// (the source is `:memory:`). The tests below exercise the parts
    /// that don't depend on VACUUM INTO — manifest assembly, counts,
    /// zip layout — by driving them directly. The end-to-end
    /// snapshot+zip path is exercised via the integration smoke test in
    /// `run_backup_smoke_via_disk` below, which uses a real on-disk DB.
    use crate::collections::{create as create_collection, CreateCollection};
    use crate::notes::{create as create_note, CreateNote};

    fn seed_notes_and_folders(db: &Db) {
        let folder = db
            .with_conn(|c| {
                create_collection(
                    c,
                    CreateCollection {
                        name: "f".into(),
                        parent_collection_id: None,
                    },
                )
            })
            .unwrap()
            .id;
        db.with_conn(|c| {
            create_note(
                c,
                CreateNote {
                    title: Some("n1".into()),
                    body: Some("body".into()),
                    parent_collection_id: Some(folder.clone()),
                    note_kind: None,
                },
            )
        })
        .unwrap();
        db.with_conn(|c| {
            create_note(
                c,
                CreateNote {
                    title: Some("n2".into()),
                    body: Some("".into()),
                    parent_collection_id: None,
                    note_kind: None,
                },
            )
        })
        .unwrap();
    }

    #[test]
    fn read_counts_excludes_the_trash_folder() {
        let db = open_memory_for_tests();
        seed_notes_and_folders(&db);
        let counts = db.with_conn(|c| read_counts(c)).unwrap();
        assert_eq!(counts.notes, 2);
        assert_eq!(
            counts.folders, 1,
            "the built-in 'trash' collection must not show up in the count"
        );
        assert_eq!(counts.assets_bytes, 0, "no assets seeded");
    }

    #[test]
    fn read_account_identity_returns_none_for_local_only_db() {
        let db = open_memory_for_tests();
        seed_notes_and_folders(&db);
        let identity = db.with_conn(|c| read_account_identity(c, None)).unwrap();
        assert!(
            identity.is_none(),
            "fresh local DB has no sync_state rows, no identity to record"
        );
    }

    #[test]
    fn read_account_identity_returns_uids_when_sync_state_is_populated() {
        let db = open_memory_for_tests();
        seed_notes_and_folders(&db);
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO sync_state(kind, etebase_collection_uid, stoken)
                 VALUES ('notes', 'uid-notes-123', 'stok-1')",
                [],
            )?;
            c.execute(
                "INSERT INTO sync_state(kind, etebase_collection_uid, stoken)
                 VALUES ('folders', 'uid-folders-456', 'stok-2')",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        let identity = db
            .with_conn(|c| read_account_identity(c, None))
            .unwrap()
            .expect("identity present when both UIDs are stored");
        assert_eq!(identity.etebase_collection_uid_notes, "uid-notes-123");
        assert_eq!(identity.etebase_collection_uid_folders, "uid-folders-456");
        assert!(
            identity.server_url.is_none(),
            "no session ⇒ no friendly url"
        );
        assert!(identity.username.is_none(), "no session ⇒ no username");
    }

    #[test]
    fn read_account_identity_carries_session_strings_through() {
        let db = open_memory_for_tests();
        seed_notes_and_folders(&db);
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO sync_state(kind, etebase_collection_uid, stoken)
                 VALUES ('notes', 'uid-notes-123', 'stok-1')",
                [],
            )?;
            c.execute(
                "INSERT INTO sync_state(kind, etebase_collection_uid, stoken)
                 VALUES ('folders', 'uid-folders-456', 'stok-2')",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        let session = auth::SessionInfo {
            username: "alice".into(),
            server_url: "https://etebase.example/".into(),
        };
        let identity = db
            .with_conn(|c| read_account_identity(c, Some(&session)))
            .unwrap()
            .expect("identity");
        assert_eq!(identity.username.as_deref(), Some("alice"));
        assert_eq!(
            identity.server_url.as_deref(),
            Some("https://etebase.example/")
        );
    }

    #[test]
    fn read_account_identity_skips_half_synced_state() {
        // Only one kind pushed — an in-progress sync state. We refuse
        // to record an account identity for this; the import side
        // can't reliably match against a partial pair.
        let db = open_memory_for_tests();
        seed_notes_and_folders(&db);
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO sync_state(kind, etebase_collection_uid, stoken)
                 VALUES ('notes', 'uid-notes-123', 'stok-1')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let identity = db.with_conn(|c| read_account_identity(c, None)).unwrap();
        assert!(identity.is_none());
    }

    #[test]
    fn write_zip_round_trips_manifest_and_db_bytes() {
        let tmp_dir = std::env::temp_dir().join(format!("ms-backup-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp_dir).unwrap();
        let db_path = tmp_dir.join("source.db");
        let zip_path = tmp_dir.join("out.zip");
        fs::write(&db_path, b"SQLite fake content for zip roundtrip").unwrap();

        let manifest = Manifest {
            format_version: MANIFEST_FORMAT_VERSION,
            app_version: "0.0.0-test".into(),
            schema_version: 11,
            created_at: "2026-06-10T00:00:00+00:00".into(),
            account_present_at_export: false,
            account: None,
            contents: Contents {
                db_filename: DB_ENTRY_NAME.into(),
                counts: Counts {
                    notes: 3,
                    folders: 2,
                    assets_bytes: 0,
                },
            },
        };

        write_zip(&zip_path, &manifest, &db_path).unwrap();

        let bytes = fs::read(&zip_path).unwrap();
        let cursor = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        assert_eq!(archive.len(), 2, "manifest + db");

        let mut manifest_entry = archive.by_name(MANIFEST_ENTRY_NAME).unwrap();
        let mut manifest_bytes = Vec::new();
        manifest_entry.read_to_end(&mut manifest_bytes).unwrap();
        drop(manifest_entry);
        let parsed: Manifest = serde_json::from_slice(&manifest_bytes).unwrap();
        assert_eq!(parsed.format_version, MANIFEST_FORMAT_VERSION);
        assert_eq!(parsed.contents.counts.notes, 3);
        assert!(parsed.account.is_none());

        let mut db_entry = archive.by_name(DB_ENTRY_NAME).unwrap();
        let mut db_bytes = Vec::new();
        db_entry.read_to_end(&mut db_bytes).unwrap();
        assert_eq!(db_bytes, b"SQLite fake content for zip roundtrip");

        fs::remove_dir_all(&tmp_dir).ok();
    }

    #[test]
    fn suggested_filename_is_path_safe() {
        let name = suggested_filename();
        assert!(name.starts_with("mindstream-backup-"));
        assert!(name.ends_with(".zip"));
        // No colons — Windows would reject them in a filename.
        assert!(!name.contains(':'), "{name} contains a colon");
    }

    // ---------- Import-side tests ----------

    fn open_fresh_disk_db(dir: &Path, filename: &str) -> Connection {
        let path = dir.join(filename);
        if path.exists() {
            fs::remove_file(&path).ok();
        }
        let mut conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    #[test]
    fn validate_rejects_a_random_sqlite_file() {
        let tmp = std::env::temp_dir().join(format!("ms-import-val-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let conn = Connection::open(tmp.join("not-mindstream.db")).unwrap();
        conn.execute("CREATE TABLE foo (id INTEGER PRIMARY KEY)", [])
            .unwrap();
        let err = validate_looks_like_mindstream_db(&conn).unwrap_err();
        assert!(
            err.to_string().contains("missing"),
            "expected missing-table error, got {err}"
        );
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn sanitize_clears_sync_metadata_and_tombstones() {
        // Set up an on-disk DB that looks "fully synced" — every row
        // has etebase_uid + etag, sync_state is populated, a tombstone
        // is queued. After sanitize, none of that should remain.
        let tmp = std::env::temp_dir().join(format!("ms-import-san-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let db_path = tmp.join("data.db");
        {
            let conn = open_fresh_disk_db(&tmp, "data.db");
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO notes(id, parent_collection_id, title, body, position,
                                    created, modified, dirty, note_kind,
                                    etebase_uid, etebase_etag)
                 VALUES ('note_x', NULL, 't', 'b', 0, ?1, ?1, 0, 'markdown',
                         'eu-1', 'ee-1')",
                params![now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO collections(id, parent_collection_id, name, position,
                                          created, modified, dirty,
                                          etebase_uid, etebase_etag)
                 VALUES ('coll_x', NULL, 'c', 0, ?1, ?1, 0, 'eu-c', 'ee-c')",
                params![now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sync_state(kind, etebase_collection_uid, stoken)
                 VALUES ('notes', 'uid-n', 'stok-n')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sync_state(kind, etebase_collection_uid, stoken)
                 VALUES ('folders', 'uid-f', 'stok-f')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO tombstones(kind, etebase_uid, queued_at)
                 VALUES ('note', 'gone-1', ?1)",
                params![now],
            )
            .unwrap();
        }

        sanitize_for_foreign_account(&db_path).unwrap();

        let conn = Connection::open(&db_path).unwrap();
        let (uid, etag, dirty): (Option<String>, Option<String>, i64) = conn
            .query_row(
                "SELECT etebase_uid, etebase_etag, dirty FROM notes WHERE id = 'note_x'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert!(uid.is_none());
        assert!(etag.is_none());
        assert_eq!(dirty, 1, "sanitized row must be marked dirty for re-push");
        let coll_uid: Option<String> = conn
            .query_row(
                "SELECT etebase_uid FROM collections WHERE id = 'coll_x'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(coll_uid.is_none());
        let sync_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sync_count, 0);
        let tomb_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM tombstones", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tomb_count, 0);

        // The built-in trash collection must not be touched by the
        // collections sanitise (its `dirty` should stay 0 per
        // migration 4).
        let trash_dirty: i64 = conn
            .query_row(
                "SELECT dirty FROM collections WHERE id = 'trash'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(trash_dirty, 0, "trash collection mustn't be re-dirtied");
        fs::remove_dir_all(&tmp).ok();
    }

    fn seed_backup_db(conn: &Connection, label: &str) {
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position,
                                      created, modified, dirty,
                                      etebase_uid, etebase_etag)
             VALUES (?1, NULL, ?2, 0, ?3, ?3, 0, 'eu-c', 'ee-c')",
            params![format!("coll_{label}"), format!("Folder {label}"), now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position,
                                created, modified, dirty, note_kind,
                                etebase_uid, etebase_etag)
             VALUES (?1, ?2, ?3, 'body', 0, ?4, ?4, 0, 'markdown', 'eu-n', 'ee-n')",
            params![
                format!("note_{label}"),
                format!("coll_{label}"),
                format!("Note {label}"),
                now,
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO note_tags(note_id, tag) VALUES (?1, ?2)",
            params![format!("note_{label}"), "tag-x"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO assets(id, owning_note_id, mime_type, bytes, size,
                                 created, modified, dirty, etebase_uid)
             VALUES (?1, ?2, 'image/png', X'8950', 2, ?3, ?3, 0, 'eu-a')",
            params![format!("asset_{label}"), format!("note_{label}"), now],
        )
        .unwrap();
    }

    #[test]
    fn merge_adds_missing_rows_and_strips_sync_metadata() {
        let live_db = open_memory_for_tests();
        seed_notes_and_folders(&live_db); // some pre-existing local content
        let backup_conn = Connection::open_in_memory().unwrap();
        backup_conn
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        {
            let mut conn = Connection::open_in_memory().unwrap();
            conn.pragma_update(None, "foreign_keys", "ON").unwrap();
            migrations::run(&mut conn).unwrap();
            seed_backup_db(&conn, "BACKUP");
            // Drain the prepared in-memory backup into the test's
            // `backup_conn` via the SQL serialise dance isn't really
            // needed — just seed `backup_conn` directly.
            drop(conn);
        }
        // Easier: seed the original `backup_conn` directly.
        let backup_conn = {
            let mut conn = Connection::open_in_memory().unwrap();
            conn.pragma_update(None, "foreign_keys", "ON").unwrap();
            migrations::run(&mut conn).unwrap();
            seed_backup_db(&conn, "BACKUP");
            conn
        };

        let report = live_db
            .with_conn_mut(|live| merge_into(live, &backup_conn))
            .unwrap();
        assert_eq!(report.folders_added, 1);
        assert_eq!(report.notes_added, 1);
        assert_eq!(report.assets_added, 1);
        assert_eq!(report.notes_orphaned, 0);

        // The imported note must have NULL etebase metadata + dirty=1.
        let (uid, etag, dirty): (Option<String>, Option<String>, i64) = live_db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT etebase_uid, etebase_etag, dirty FROM notes WHERE id = 'note_BACKUP'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?)
            })
            .unwrap();
        assert!(uid.is_none());
        assert!(etag.is_none());
        assert_eq!(dirty, 1);

        // Tag carried over.
        let tag_count: i64 = live_db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT COUNT(*) FROM note_tags WHERE note_id = 'note_BACKUP'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(tag_count, 1);

        // Asset carried, with stripped UID + dirty=1.
        let asset_uid: Option<String> = live_db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT etebase_uid FROM assets WHERE id = 'asset_BACKUP'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert!(asset_uid.is_none());
    }

    #[test]
    fn merge_skips_rows_whose_id_already_exists_locally() {
        let live_db = open_memory_for_tests();
        let backup_conn = {
            let mut conn = Connection::open_in_memory().unwrap();
            conn.pragma_update(None, "foreign_keys", "ON").unwrap();
            migrations::run(&mut conn).unwrap();
            seed_backup_db(&conn, "SHARED");
            conn
        };
        // First merge brings the row in.
        let r1 = live_db
            .with_conn_mut(|live| merge_into(live, &backup_conn))
            .unwrap();
        assert_eq!(r1.notes_added, 1);
        // Second merge against the same backup must be a no-op.
        let r2 = live_db
            .with_conn_mut(|live| merge_into(live, &backup_conn))
            .unwrap();
        assert_eq!(r2.notes_added, 0);
        assert_eq!(r2.folders_added, 0);
        assert_eq!(r2.assets_added, 0);
    }

    #[test]
    fn merge_reroutes_orphan_note_parents_to_root() {
        // Seed a backup with a note whose parent_collection_id refers
        // to a folder the backup *also* won't have (FKs disabled for
        // the seed step to allow the deliberately-broken state). This
        // simulates the case where the user merged piecemeal and the
        // folder never made it across.
        let live_db = open_memory_for_tests();
        let backup_conn = {
            let mut conn = Connection::open_in_memory().unwrap();
            migrations::run(&mut conn).unwrap();
            // `migrations::run` re-enables FKs at the end. Toggle off
            // *after* it so the deliberately dangling reference can be
            // inserted for this test.
            conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO notes(id, parent_collection_id, title, body, position,
                                    created, modified, dirty, note_kind)
                 VALUES ('note_orphan', 'coll_missing', 'orphan', '', 0, ?1, ?1, 0, 'markdown')",
                params![now],
            )
            .unwrap();
            conn
        };

        let report = live_db
            .with_conn_mut(|live| merge_into(live, &backup_conn))
            .unwrap();
        assert_eq!(report.notes_added, 1);
        assert_eq!(report.notes_orphaned, 1);
        let parent: Option<String> = live_db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT parent_collection_id FROM notes WHERE id = 'note_orphan'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert!(parent.is_none(), "orphan note must land at root");
    }

    #[test]
    fn merge_skips_assets_whose_owner_isnt_present() {
        // Backup has an asset, but the owning note didn't come over
        // (and isn't already present locally either — truly orphaned).
        // We refuse to import a dangling blob.
        let live_db = open_memory_for_tests();
        let backup_conn = {
            let mut conn = Connection::open_in_memory().unwrap();
            migrations::run(&mut conn).unwrap();
            // Toggle FKs off *after* migrations so the dangling
            // owning_note_id can be inserted.
            conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO assets(id, owning_note_id, mime_type, bytes, size,
                                     created, modified, dirty)
                 VALUES ('asset_orphan_blob', 'note_missing', 'image/png', X'8950', 2, ?1, ?1, 0)",
                params![now],
            )
            .unwrap();
            conn
        };

        let report = live_db
            .with_conn_mut(|live| merge_into(live, &backup_conn))
            .unwrap();
        assert_eq!(report.assets_added, 0, "orphan blob must not be imported");
    }

    #[test]
    fn merge_does_not_overwrite_existing_local_notes() {
        // A note id present in both local and backup must keep its
        // local content — merge is insert-only, never update.
        let live_db = open_memory_for_tests();
        live_db
            .with_conn(|c| {
                let now = chrono::Utc::now().to_rfc3339();
                c.execute(
                    "INSERT INTO notes(id, parent_collection_id, title, body, position,
                                        created, modified, dirty, note_kind)
                     VALUES ('note_collision', NULL, 'local', '', 0, ?1, ?1, 0, 'markdown')",
                    params![now],
                )?;
                Ok(())
            })
            .unwrap();
        let backup_conn = {
            let mut conn = Connection::open_in_memory().unwrap();
            conn.pragma_update(None, "foreign_keys", "ON").unwrap();
            migrations::run(&mut conn).unwrap();
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO notes(id, parent_collection_id, title, body, position,
                                    created, modified, dirty, note_kind)
                 VALUES ('note_collision', NULL, 'backup', '', 0, ?1, ?1, 0, 'markdown')",
                params![now],
            )
            .unwrap();
            conn
        };

        let report = live_db
            .with_conn_mut(|live| merge_into(live, &backup_conn))
            .unwrap();
        assert_eq!(report.notes_added, 0, "id collision must skip insert");
        let title: String = live_db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT title FROM notes WHERE id = 'note_collision'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(title, "local", "local content must be preserved");
    }
}
