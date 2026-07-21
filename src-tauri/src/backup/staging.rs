//! Import staging: extract a backup zip into a per-import staging
//! directory, migrate the staged DB, and describe it as an
//! [`ImportPreview`] the UI can confirm against.
//!
//! The staging directory's name is the `token` every later import call
//! (restore, merge, cleanup) uses to identify which staged copy it means.

use super::*;

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

pub(super) const SENTINEL_FILE: &str = "pending-restore.flag";
pub(super) const PENDING_DB_FILE: &str = "pending-restore.db";

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

pub(super) async fn import_begin_inner(app: AppHandle) -> AppResult<Option<ImportPreview>> {
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

pub(super) fn stage_import(
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

pub(super) fn extract_zip_into(
    source_zip: &Path,
    dir: &Path,
    db_target: &Path,
) -> AppResult<Manifest> {
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

pub(super) fn validate_looks_like_mindstream_db(conn: &Connection) -> AppResult<()> {
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
