//! Backup export: snapshot the live DB with `VACUUM INTO`, describe it
//! in a manifest, and zip the pair to a user-chosen path.

use super::*;

/// Conventional default location for backups (`<app_data>/backups/`).
/// The directory is created lazily by `run_backup` when an export
/// actually lands; we don't pre-create here because the dialog's
/// `defaultPath` works whether the directory exists or not.
pub(super) fn default_backup_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(crate::paths::app_data_dir(app)?.join("backups"))
}

/// Path-safe suggested filename — `T<HH-MM-SS>` (hyphens, not colons)
/// so Windows accepts it.
pub(super) fn suggested_filename() -> String {
    let now = chrono::Utc::now();
    format!("mindstream-backup-{}.zip", now.format("%Y-%m-%dT%H-%M-%S"))
}

/// Pop the Save-As dialog, then run the export. Returns `None` when
/// the user cancels — distinct from an error — so the JS side stays
/// quiet (no error toast for a deliberate cancel).
///
/// Mirrors the dialog-then-write pattern in `pdf_export.rs`.
#[tauri::command]
pub async fn backup_now(app: AppHandle) -> CommandResult<Option<BackupReport>> {
    backup_now_inner(app).await.map_err(Into::into)
}

pub(super) async fn backup_now_inner(app: AppHandle) -> AppResult<Option<BackupReport>> {
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

    let job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    let session = auth::read_session_info(&app)?;
    // The DB lock is sync; run the export on a blocking thread so the
    // async dialog future stays cooperative. Reach for the Db state
    // inside the closure since `tauri::State` isn't `Send`.
    let app_for_blocking = app.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        let _job = job;
        let db = app_for_blocking.state::<Db>();
        db.with_conn_mut(|conn| run_backup(&app_for_blocking, conn, &destination, session.as_ref()))
    })
    .await
    .map_err(|e| AppError::InvalidArg(format!("backup task: {e}")))??;
    Ok(Some(report))
}

/// Take out of a copy of the database what is of use on this device only.
///
/// The room keys kept here are sealed for this device's session and open
/// nowhere else. A backup is made to leave the device, so they are not in
/// it. `secure_delete` has the freed pages overwritten, so that they are
/// gone from the file and not only from the table. A restored backup gets
/// them again from the server.
pub(super) fn leave_device_secrets_out(snapshot: &Connection) -> AppResult<()> {
    snapshot.pragma_update(None, "secure_delete", "ON")?;
    crate::sync::room_keys::forget_all(snapshot)
}

pub(super) fn run_backup(
    app: &AppHandle,
    conn: &mut Connection,
    destination: &Path,
    session: Option<&auth::SessionInfo>,
) -> AppResult<BackupReport> {
    run_backup_at(
        &crate::paths::app_data_root(app)?,
        &crate::paths::app_data_dir(app)?,
        conn,
        destination,
        session,
    )
}

pub(super) fn run_backup_at(
    root: &Path,
    vault: &Path,
    conn: &mut Connection,
    destination: &Path,
    session: Option<&auth::SessionInfo>,
) -> AppResult<BackupReport> {
    validate_destination(root, vault, destination)?;
    // Snapshot lives under `<app_data>/backups/.staging/<uuid>.db` —
    // same drive as the live DB so VACUUM INTO is fast, separated from
    // the user's chosen output dir so it stays clean. We delete the
    // staging file at the end regardless of outcome.
    let staging_dir = vault.join("backups").join(".staging");
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
    let resources_dir = staging_dir.join(format!("resources-{}", uuid::Uuid::new_v4()));
    let _resources_cleanup = DirectoryCleanup(resources_dir.clone());

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
    leave_device_secrets_out(&snapshot)?;
    let counts = read_counts(&snapshot)?;
    let identity = read_account_identity(&snapshot, session)?;
    let schema_version: u32 = snapshot.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    drop(snapshot);

    let resources = portable::capture(root, vault, conn, &resources_dir)?;
    portable::sanitize_database(&staging_db, Some(&resources_dir))?;

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
        data_db_sha256: Some(super::restore::restore_file_hash(&staging_db)?),
        portable: Some(resources),
    };

    // Atomic write: zip into `<destination>.tmp`, fsync the parent
    // dir, rename to `<destination>`. A crashed export leaves the tmp
    // file but never a half-written backup at the real path.
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp_path = with_extra_extension(destination, &format!("{}.tmp", uuid::Uuid::new_v4()));
    let _zip_cleanup = StagingCleanup(tmp_path.clone());
    write_zip_with_resources(&tmp_path, &manifest, &staging_db, Some(&resources_dir))?;
    fs::rename(&tmp_path, destination)?;
    if let Some(parent) = destination.parent() {
        crate::atomic_file::sync_directory(parent)?;
    }

    Ok(BackupReport {
        destination: destination
            .to_str()
            .map(|s| s.to_string())
            .unwrap_or_else(|| destination.to_string_lossy().into_owned()),
        counts,
        account_present: manifest.account_present_at_export,
    })
}

fn validate_destination(root: &Path, vault: &Path, destination: &Path) -> AppResult<()> {
    let name = destination
        .file_name()
        .ok_or_else(|| AppError::InvalidArg("backup filename missing".into()))?;
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let resolved = if destination.try_exists()? {
        destination.canonicalize()?
    } else {
        parent.canonicalize()?.join(name)
    };
    let root = root.canonicalize()?;
    let vault = vault.canonicalize()?;
    if (resolved.starts_with(&root) || resolved.starts_with(&vault))
        && (!resolved
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
            || !(resolved.parent() == Some(root.as_path())
                || resolved.parent() == Some(vault.as_path())
                || resolved.starts_with(root.join("backups"))
                || resolved.starts_with(vault.join("backups"))))
    {
        return Err(AppError::InvalidArg("inside app storage, save the backup ZIP in the backups folder or outside the app's managed folders".into()));
    }
    for directory in [root, vault] {
        for name in [
            "mindstream.db",
            "mindstream.db-wal",
            "mindstream.db-shm",
            "content-settings.json",
            "content-settings.migrated",
            "ui-settings.json",
            "desktop-settings.json",
            "plugin-settings.json",
            "theme-presets.json",
            "profiles.json",
            PENDING_DB_FILE,
            SENTINEL_FILE,
        ] {
            if resolved == directory.join(name) {
                return Err(AppError::InvalidArg(
                    "backup destination is an application storage file".into(),
                ));
            }
        }
        for name in [
            "plugins",
            "plugin-packages",
            "plugin-data",
            "plugin-artifacts",
            portable::PENDING,
        ] {
            if resolved.starts_with(directory.join(name)) {
                return Err(AppError::InvalidArg(
                    "backup destination is inside managed plugin storage".into(),
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn read_counts(conn: &Connection) -> AppResult<Counts> {
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

pub(super) fn read_account_identity(
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

#[cfg(test)]
pub(super) fn write_zip(zip_path: &Path, manifest: &Manifest, db_path: &Path) -> AppResult<()> {
    write_zip_with_resources(zip_path, manifest, db_path, None)
}

fn write_zip_with_resources(
    zip_path: &Path,
    manifest: &Manifest,
    db_path: &Path,
    resources: Option<&Path>,
) -> AppResult<()> {
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
    std::io::copy(&mut fs::File::open(db_path)?, &mut zip)?;
    if let Some(index) = &manifest.portable {
        let directory = resources
            .ok_or_else(|| AppError::InvalidArg("backup resource directory missing".into()))?;
        portable::validate_bundle(directory, index)?;
        for entry in &index.files {
            zip.start_file(&entry.path, opts.unix_permissions(entry.mode))
                .map_err(zip_to_app)?;
            std::io::copy(&mut fs::File::open(directory.join(&entry.path))?, &mut zip)?;
        }
    }

    zip.finish().map_err(zip_to_app)?.sync_all()?;
    Ok(())
}

pub(super) fn zip_to_app(e: zip::result::ZipError) -> AppError {
    AppError::InvalidArg(format!("zip: {e}"))
}

pub(super) fn with_extra_extension(path: &Path, extra: &str) -> PathBuf {
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
pub(super) struct StagingCleanup(PathBuf);

impl Drop for StagingCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub(super) struct DirectoryCleanup(pub PathBuf);
impl Drop for DirectoryCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
impl DirectoryCleanup {
    pub(super) fn keep(mut self) {
        self.0 = PathBuf::new();
    }
}
