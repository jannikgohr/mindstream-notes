//! Restore-replace: hand a staged DB over to the boot hook.
//!
//! The live DB is already open when the user confirms, so the swap
//! can't happen in-process. Instead we park the staged file next to the
//! live one, drop a sentinel, and let the next launch move it in.

use super::*;
use rusqlite::OpenFlags;
use sha2::{Digest, Sha256};

/// Restore-replace: sanitize sync metadata if the account mismatches,
/// then move the staged DB into `<app_data>/pending-restore.db` and
/// write the sentinel. JS reads the returned flag and prompts the
/// user to relaunch; the boot hook does the swap.
#[tauri::command]
pub fn import_restore(
    app: AppHandle,
    token: String,
    same_account: bool,
    include_device: Option<bool>,
) -> CommandResult<RestoreStaged> {
    let _job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    let app_data = crate::paths::app_data_dir(&app)?;
    let dir = portable::token_directory(&imports_staging_root(&app)?, &token)?;
    Ok(app.state::<Db>().with_conn(|live| {
        stage_restore_at(
            &app_data,
            &dir,
            live,
            same_account,
            include_device.unwrap_or(false),
        )
    })?)
}

pub(super) fn stage_restore_at(
    app_data: &Path,
    dir: &Path,
    live: &Connection,
    same_account: bool,
    include_device: bool,
) -> AppResult<RestoreStaged> {
    let staged = dir.join("data.db");
    if !staged.exists() {
        return Err(AppError::InvalidArg("staged backup not found".into()));
    }
    let pending_db = app_data.join(PENDING_DB_FILE);
    let sentinel = app_data.join(SENTINEL_FILE);

    if sentinel.exists() {
        return Err(
            AppError::InvalidArg("a restore is already pending; restart Mindstream Notes to finish it before starting another".into()),
        );
    }

    let manifest: Manifest = serde_json::from_slice(&fs::read(dir.join(MANIFEST_ENTRY_NAME))?)
        .map_err(|e| AppError::InvalidArg(e.to_string()))?;
    if let Some(index) = &manifest.portable {
        portable::validate_bundle(dir, index)?;
    }
    let identity = read_account_identity(&Connection::open(&staged)?, None)?;
    let matches = {
        let current = read_account_identity(live, None)?;
        match (&identity, current) {
            (Some(backup), Some(current)) => {
                backup.etebase_collection_uid_notes == current.etebase_collection_uid_notes
                    && backup.etebase_collection_uid_folders
                        == current.etebase_collection_uid_folders
            }
            _ => false,
        }
    };
    let same_account = same_account && matches;

    // Sanitize on the staged file, not on the pending file, so a
    // failure here leaves no half-prepared pending in place.
    if !same_account {
        sanitize_for_foreign_account(&staged)?;
    }
    portable::sanitize_database(&staged, manifest.portable.as_ref().map(|_| dir))?;
    checkpoint_for_move(&staged)?;

    // Move-then-mark: the sentinel must not exist until the staged DB
    // is fully in place. Otherwise a crash between the two leaves the
    // app thinking a restore is ready when the file isn't there.
    // Preserve preparations that never committed a sentinel. They cannot be
    // replayed automatically and must not be silently overwritten by a retry.
    for old in [&pending_db, &app_data.join(portable::PENDING)] {
        if old.try_exists()? {
            let safety = app_data
                .join("backups")
                .join(format!("uncommitted-restore-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(
                safety
                    .parent()
                    .ok_or_else(|| AppError::InvalidArg("restore parent missing".into()))?,
            )?;
            fs::rename(old, safety)?;
        }
    }
    fs::rename(&staged, &pending_db)?;
    crate::atomic_file::sync_file(&pending_db)?;
    crate::atomic_file::sync_directory(app_data)?;
    let portable_sha256 = manifest
        .portable
        .as_ref()
        .map(|index| portable::stage(dir, app_data, index))
        .transpose()?;
    let operation = RestoreOperation {
        format_version: 2,
        phase: RestorePhase::Prepared,
        safety_filename: safety_filename(app_data.join("mindstream.db").exists()),
        pending_sha256: restore_file_hash(&pending_db)?,
        portable_sha256,
        include_device,
    };
    operation.save(&sentinel)?;

    // The staging dir's now empty of its data.db; drop the dir
    // entirely so a future import_begin doesn't sweep it later.
    let _ = fs::remove_dir_all(dir);

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

pub(super) fn sanitize_for_foreign_account(staged_db: &Path) -> AppResult<()> {
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

pub(super) fn imports_staging_root(app: &AppHandle) -> AppResult<PathBuf> {
    let root = crate::paths::app_data_dir(app)?
        .join("imports")
        .join(".staging");
    fs::create_dir_all(&root)?;
    Ok(root)
}

/// Staging entries never outlive the process that created them: a committed
/// restore has already moved its inputs out. The caller holds the vault lease,
/// so nothing else can be staging here.
pub(super) fn sweep_abandoned_staging(vault: &Path) {
    for staging in [
        vault.join("imports").join(".staging"),
        vault.join("backups").join(".staging"),
    ] {
        if !fs::symlink_metadata(&staging).is_ok_and(|meta| meta.is_dir()) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&staging) else {
            continue;
        };
        for entry in entries.flatten() {
            let removed = match entry.file_type() {
                Ok(kind) if kind.is_dir() => fs::remove_dir_all(entry.path()),
                Ok(_) => fs::remove_file(entry.path()),
                Err(err) => Err(err),
            };
            if let Err(err) = removed {
                log::warn!("[restore] abandoned staging entry retained: {err}");
            }
        }
    }
}

/// Run at startup *before* `Db::open`. If a previous session staged a
/// restore, preserve the old DB and install the replacement. An unresolved
/// restore stops boot so Db::open cannot create or migrate an ambiguous DB.
pub fn apply_pending_restore_if_any(app: &AppHandle) -> AppResult<()> {
    let vault = crate::paths::app_data_dir(app)?;
    sweep_abandoned_staging(&vault);
    let sentinel = vault.join(SENTINEL_FILE);
    if sentinel.try_exists()? {
        apply_pending_restore_with_root(
            &crate::paths::app_data_root(app)?,
            &vault,
            &vault.join(PENDING_DB_FILE),
            &sentinel,
        )?;
        crate::plugins::settings::notify(app);
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn reconcile_pending_restore(app_data: &Path) -> AppResult<()> {
    let sentinel = app_data.join(SENTINEL_FILE);
    let pending = app_data.join(PENDING_DB_FILE);
    match fs::metadata(&sentinel) {
        Ok(_) => apply_pending_restore(app_data, &pending, &sentinel),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum RestorePhase {
    Prepared,
    OldPreserved,
    Installed,
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct RestoreOperation {
    pub format_version: u32,
    pub phase: RestorePhase,
    pub safety_filename: Option<String>,
    pub pending_sha256: String,
    #[serde(default)]
    pub portable_sha256: Option<String>,
    #[serde(default)]
    pub include_device: bool,
}

impl RestoreOperation {
    pub(super) fn save(&self, sentinel: &Path) -> AppResult<()> {
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|err| AppError::InvalidArg(format!("serialize restore operation: {err}")))?;
        crate::atomic_file::write(sentinel, &bytes)?;
        Ok(())
    }

    fn validate(&self) -> AppResult<()> {
        if !matches!(self.format_version, 1 | 2)
            || (self.portable_sha256.is_some() && self.format_version != 2)
            || self.pending_sha256.len() != 64
            || !self
                .pending_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || self.portable_sha256.as_ref().is_some_and(|hash| {
                hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit())
            })
        {
            return Err(AppError::InvalidArg(
                "unsupported or invalid restore operation".into(),
            ));
        }
        if let Some(name) = &self.safety_filename {
            if !name.starts_with("mindstream-pre-restore-")
                || !name.ends_with(".db")
                || name.contains(['/', '\\', ':'])
                || name.contains("..")
            {
                return Err(AppError::InvalidArg(
                    "unsafe restore safety filename".into(),
                ));
            }
        }
        Ok(())
    }
}

pub(super) fn restore_file_hash(path: &Path) -> AppResult<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn validate_restore_database(path: &Path) -> AppResult<()> {
    // Never create a missing file during recovery, and never migrate inputs.
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    validate_looks_like_mindstream_db(&conn)?;
    let mut statement = conn.prepare("PRAGMA quick_check")?;
    let results = statement.query_map([], |row| row.get::<_, String>(0))?;
    for result in results {
        let result = result?;
        if result != "ok" {
            return Err(AppError::InvalidArg(format!(
                "restore database {} failed validation: {result}",
                path.display()
            )));
        }
    }
    Ok(())
}

fn checkpoint_for_move(path: &Path) -> AppResult<()> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    conn.busy_timeout(std::time::Duration::ZERO)?;
    conn.pragma_update(None, "locking_mode", "EXCLUSIVE")?;
    // Force recovery and obtain SQLite ownership before the checkpoint. A busy
    // connection must prevent the rename, not merely produce a warning.
    conn.query_row("SELECT count(*) FROM sqlite_schema", [], |row| {
        row.get::<_, i64>(0)
    })?;
    let busy: i64 = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))?;
    if busy != 0 {
        return Err(AppError::InvalidArg(format!(
            "cannot preserve {} while its WAL is busy; close other vault instances and retry",
            path.display()
        )));
    }
    conn.close().map_err(|(_, err)| AppError::Db(err))?;
    crate::atomic_file::sync_file(path)?;
    Ok(())
}

fn remove_checkpointed_sidecars(app_data: &Path) -> AppResult<()> {
    let wal = app_data.join("mindstream.db-wal");
    match fs::metadata(&wal) {
        Ok(metadata) if metadata.len() > 0 => {
            return Err(AppError::InvalidArg(
                "restore found a non-empty live WAL after preservation; recovery files retained"
                    .into(),
            ));
        }
        Ok(_) => fs::remove_file(wal)?,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }
    match fs::remove_file(app_data.join("mindstream.db-shm")) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }
    crate::atomic_file::sync_directory(app_data)?;
    Ok(())
}

fn require_restore_input(path: &Path, expected_hash: &str) -> AppResult<()> {
    // The journal identifies a standalone, checkpointed replacement. A later
    // WAL means somebody changed it; hashing only the main file would miss that.
    let mut wal = path.as_os_str().to_os_string();
    wal.push("-wal");
    match fs::metadata(Path::new(&wal)) {
        Ok(metadata) if metadata.len() > 0 => {
            return Err(AppError::InvalidArg(format!(
                "restore input {} has an unexpected WAL; recovery files retained",
                path.display()
            )));
        }
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }
    validate_restore_database(path)?;
    if restore_file_hash(path)? != expected_hash {
        return Err(AppError::InvalidArg(format!(
            "restore input {} changed; recovery files retained",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn apply_pending_restore(
    app_data: &Path,
    pending: &Path,
    sentinel: &Path,
) -> AppResult<()> {
    apply_pending_restore_with_root(app_data, app_data, pending, sentinel)
}

fn safety_filename(exists: bool) -> Option<String> {
    exists.then(|| {
        format!(
            "mindstream-pre-restore-{}-{}.db",
            chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S"),
            uuid::Uuid::new_v4()
        )
    })
}

pub(super) fn apply_pending_restore_with_root(
    root: &Path,
    app_data: &Path,
    pending: &Path,
    sentinel: &Path,
) -> AppResult<()> {
    let live = app_data.join("mindstream.db");
    let raw = fs::read(sentinel)?;
    let mut operation = if raw.is_empty() || raw == b"pending" {
        // Upgrade the old sentinel only after proving its replacement exists
        // and is valid. Missing inputs remain an error, not a cleared flag.
        validate_restore_database(pending)?;
        checkpoint_for_move(pending)?;
        let operation = RestoreOperation {
            format_version: 1,
            phase: RestorePhase::Prepared,
            safety_filename: safety_filename(live.exists()),
            pending_sha256: restore_file_hash(pending)?,
            portable_sha256: None,
            include_device: false,
        };
        operation.save(sentinel)?;
        operation
    } else {
        serde_json::from_slice::<RestoreOperation>(&raw)
            .map_err(|err| AppError::InvalidArg(format!("restore operation corrupt: {err}")))?
    };
    operation.validate()?;
    if let Some(hash) = &operation.portable_sha256 {
        portable::pending_index(app_data, hash)?;
    }
    let safety = operation
        .safety_filename
        .as_ref()
        .map(|name| app_data.join(name));

    if operation.phase == RestorePhase::Prepared {
        require_restore_input(pending, &operation.pending_sha256)?;
        if let Some(safety) = &safety {
            match (live.exists(), safety.exists()) {
                (true, false) => {
                    checkpoint_for_move(&live)?;
                    fs::rename(&live, safety)?;
                    crate::atomic_file::sync_directory(app_data)?;
                }
                (false, true) => validate_restore_database(safety)?,
                _ => {
                    return Err(AppError::InvalidArg(
                        "ambiguous restore preservation state".into(),
                    ))
                }
            }
        } else if live.exists() {
            return Err(AppError::InvalidArg(
                "unexpected live DB during restore".into(),
            ));
        }
        operation.phase = RestorePhase::OldPreserved;
        operation.save(sentinel)?;
    }

    if operation.phase == RestorePhase::OldPreserved {
        if safety.as_ref().is_some_and(|path| !path.is_file()) {
            return Err(AppError::InvalidArg(
                "restore safety copy is missing".into(),
            ));
        }
        match (pending.exists(), live.exists()) {
            (true, false) => {
                require_restore_input(pending, &operation.pending_sha256)?;
                remove_checkpointed_sidecars(app_data)?;
                fs::rename(pending, &live)?;
                crate::atomic_file::sync_directory(app_data)?;
            }
            (false, true) => require_restore_input(&live, &operation.pending_sha256)?,
            _ => {
                return Err(AppError::InvalidArg(
                    "ambiguous restore installation state".into(),
                ))
            }
        }
        operation.phase = RestorePhase::Installed;
        operation.save(sentinel)?;
    }

    require_restore_input(&live, &operation.pending_sha256)?;
    if let Some(hash) = &operation.portable_sha256 {
        portable::apply(root, app_data, hash, operation.include_device)?;
    }
    {
        let conn = Connection::open_with_flags(&live, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'plugin_settings')", [], |row| row.get(0))?;
        if exists {
            let rows = conn
                .prepare("SELECT plugin_id, key FROM plugin_settings")?
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            crate::plugins::settings::seal_restored_rows(root, &rows)?;
        }
    }
    fs::remove_file(sentinel)?;
    crate::atomic_file::sync_directory(app_data)?;
    if let Some(hash) = &operation.portable_sha256 {
        let safety = app_data
            .join("backups")
            .join(format!("pre-restore-files-{hash}"));
        // The committed restore no longer depends on these bytes. Keep them
        // as evidence; an archival failure must not undo the installed vault.
        if let Err(error) = fs::rename(
            app_data.join(portable::PENDING),
            safety.join("restored-resources"),
        ) {
            log::warn!("[restore] resource evidence retained in place: {error}");
        }
    }
    log::info!("[restore] pending restore applied");
    Ok(())
}
