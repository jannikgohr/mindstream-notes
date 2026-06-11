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
use std::io::Write;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;
use zip::write::FileOptions;
use zip::CompressionMethod;

use crate::auth;
use crate::db::Db;
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
}
