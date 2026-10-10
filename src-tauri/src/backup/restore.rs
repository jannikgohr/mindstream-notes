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
) -> CommandResult<RestoreStaged> {
    let app_data = crate::paths::app_data_dir(&app)?;
    let staged = imports_staging_root(&app)?.join(&token).join("data.db");
    if !staged.exists() {
        return Err(format!("staged backup '{token}' not found").into());
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
        sanitize_for_foreign_account(&staged)?;
    }

    // Move-then-mark: the sentinel must not exist until the staged DB
    // is fully in place. Otherwise a crash between the two leaves the
    // app thinking a restore is ready when the file isn't there.
    if pending_db.exists() {
        fs::remove_file(&pending_db)?;
    }
    fs::rename(&staged, &pending_db)?;
    crate::atomic_file::sync_file(&pending_db)?;
    crate::atomic_file::sync_directory(&app_data)?;
    crate::atomic_file::write(&sentinel, b"pending")?;

    // The staging dir's now empty of its data.db; drop the dir
    // entirely so a future import_begin doesn't sweep it later.
    let dir = imports_staging_root(&app)?.join(&token);
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

pub(super) fn sweep_staging_root(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let _ = fs::remove_dir_all(entry.path());
    }
}

/// Run at startup *before* `Db::open`. If a previous session staged a
/// restore, preserve the old DB and install the replacement. An unresolved
/// restore stops boot so Db::open cannot create or migrate an ambiguous DB.
pub fn apply_pending_restore_if_any(app: &AppHandle) -> AppResult<()> {
    reconcile_pending_restore(&crate::paths::app_data_dir(app)?)
}

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
}

impl RestoreOperation {
    pub(super) fn save(&self, sentinel: &Path) -> AppResult<()> {
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|err| AppError::InvalidArg(format!("serialize restore operation: {err}")))?;
        crate::atomic_file::write(sentinel, &bytes)?;
        Ok(())
    }

    fn validate(&self) -> AppResult<()> {
        if self.format_version != 1
            || self.pending_sha256.len() != 64
            || !self
                .pending_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
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

pub(super) fn apply_pending_restore(
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
            safety_filename: live.exists().then(|| {
                format!(
                    "mindstream-pre-restore-{}-{}.db",
                    chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S"),
                    uuid::Uuid::new_v4()
                )
            }),
            pending_sha256: restore_file_hash(pending)?,
        };
        operation.save(sentinel)?;
        operation
    } else {
        serde_json::from_slice::<RestoreOperation>(&raw)
            .map_err(|err| AppError::InvalidArg(format!("restore operation corrupt: {err}")))?
    };
    operation.validate()?;
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
    fs::remove_file(sentinel)?;
    crate::atomic_file::sync_directory(app_data)?;
    log::info!("[restore] pending restore applied");
    Ok(())
}
