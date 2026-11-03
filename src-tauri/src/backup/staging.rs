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
    // One staging dir per import attempt. Another window may still hold a
    // choice dialog on an earlier token, so abandoned dirs are swept at the
    // next startup instead (`sweep_abandoned_staging`).
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

    let mut staged = Connection::open(&staged_db)?;
    prepare_staged(&mut staged, live_conn)?;
    let current_identity = session_identity(live_conn, session)?;
    preview_import(token, manifest, &staged, live_conn, current_identity)
        .map_err(AppError::from)
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

    let entries = (0..archive.len())
        .map(|i| Ok(archive.by_index(i).map_err(zip_to_app)?.name().to_string()))
        .collect::<AppResult<Vec<_>>>()?;
    check_manifest(&manifest, &entries)?;

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
