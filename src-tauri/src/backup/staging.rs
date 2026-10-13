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
    pub portable: bool,
    pub plugin_packages: u32,
    pub plugin_data_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountDisplay {
    pub username: Option<String>,
    pub server_url: Option<String>,
}

/// Pop the open dialog, extract+validate the picked zip, and return a
/// preview. `None` means the user cancelled the dialog.
#[tauri::command]
pub async fn import_begin(app: AppHandle) -> CommandResult<Option<ImportPreview>> {
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

    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    let session = auth::read_session_info(&app)?;
    let app_for_blocking = app.clone();
    let preview = tauri::async_runtime::spawn_blocking(move || {
        let _job = job;
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
    stage_import_at(
        &crate::paths::app_data_dir(app)?,
        source_zip,
        live_conn,
        session,
    )
}

pub(super) fn stage_import_at(
    vault: &Path,
    source_zip: &Path,
    live_conn: &Connection,
    session: Option<&auth::SessionInfo>,
) -> AppResult<ImportPreview> {
    // One staging dir per import attempt. Sweep prior dirs first —
    // they're either a crashed import (nothing to recover) or a
    // user-cancelled choice that never reached `import_cleanup`.
    let staging_root = vault.join("imports").join(".staging");
    fs::create_dir_all(&staging_root)?;

    let token = uuid::Uuid::new_v4().to_string();
    let dir = staging_root.join(&token);
    fs::create_dir_all(&dir)?;
    let cleanup = DirectoryCleanup(dir.clone());

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
        portable: manifest.portable.is_some(),
        plugin_packages: manifest
            .portable
            .as_ref()
            .map(|index| {
                index
                    .directories
                    .iter()
                    .filter(|path| {
                        path.starts_with("portable/packages/") && path.split('/').count() == 3
                    })
                    .count() as u32
            })
            .unwrap_or(0),
        plugin_data_bytes: manifest
            .portable
            .as_ref()
            .map(|index| {
                index
                    .files
                    .iter()
                    .filter(|entry| entry.path.starts_with("portable/plugin-data/"))
                    .map(|entry| entry.size)
                    .sum()
            })
            .unwrap_or(0),
    })
    .inspect(|_| cleanup.keep())
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
        let entry = archive
            .by_name(MANIFEST_ENTRY_NAME)
            .map_err(|_| AppError::InvalidArg("backup is missing manifest.json".into()))?;
        let mut bytes = Vec::new();
        if entry.size() > 128 * 1024 * 1024 {
            return Err(AppError::InvalidArg("backup manifest is too large".into()));
        }
        entry.take(128 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        serde_json::from_slice(&bytes)
            .map_err(|e| AppError::InvalidArg(format!("manifest parse: {e}")))?
    };

    if manifest.format_version == 0 || manifest.format_version > MANIFEST_FORMAT_VERSION {
        return Err(AppError::InvalidArg("unsupported backup format".into()));
    }
    if manifest.contents.db_filename != DB_ENTRY_NAME {
        return Err(AppError::InvalidArg("invalid database entry name".into()));
    }
    let mut names = std::collections::BTreeSet::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(zip_to_app)?;
        if !names.insert(entry.name().to_lowercase()) {
            return Err(AppError::InvalidArg("duplicate backup entry".into()));
        }
    }
    if manifest.format_version == 2 {
        let index = manifest
            .portable
            .as_ref()
            .ok_or_else(|| AppError::InvalidArg("backup resources missing".into()))?;
        if archive.len() != index.files.len() + 2 || manifest.data_db_sha256.is_none() {
            return Err(AppError::InvalidArg("incomplete backup".into()));
        }
    } else if manifest.portable.is_some() {
        return Err(AppError::InvalidArg(
            "legacy backup has unsupported resources".into(),
        ));
    }

    let db_name = manifest.contents.db_filename.clone();
    let mut entry = archive.by_name(&db_name).map_err(|_| {
        AppError::InvalidArg(format!("backup is missing '{db_name}' (named in manifest)"))
    })?;
    fs::create_dir_all(dir)?;
    let mut out = fs::File::create(db_target)?;
    if entry.size() > 16 * 1024 * 1024 * 1024 {
        return Err(AppError::InvalidArg("backup database is too large".into()));
    }
    std::io::copy(
        &mut entry.by_ref().take(16 * 1024 * 1024 * 1024 + 1),
        &mut out,
    )?;
    out.sync_all()?;
    drop(entry);
    drop(out);
    if let Some(hash) = &manifest.data_db_sha256 {
        if super::restore::restore_file_hash(db_target)? != *hash {
            return Err(AppError::InvalidArg(
                "backup database checksum mismatch".into(),
            ));
        }
    }
    if let Some(index) = &manifest.portable {
        portable::extract(&mut archive, dir, index)?;
    }
    crate::atomic_file::write(
        &dir.join(MANIFEST_ENTRY_NAME),
        &serde_json::to_vec(&manifest).map_err(|e| AppError::InvalidArg(e.to_string()))?,
    )?;
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
pub fn import_cleanup(app: AppHandle, token: String) -> CommandResult<()> {
    let _job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    let dir = portable::token_directory(&imports_staging_root(&app)?, &token)?;
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    Ok(())
}
