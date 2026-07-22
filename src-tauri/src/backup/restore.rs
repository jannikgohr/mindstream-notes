//! Restore-replace: hand a staged DB over to the boot hook.
//!
//! The live DB is already open when the user confirms, so the swap
//! can't happen in-process. Instead we park the staged file next to the
//! live one, drop a sentinel, and let the next launch move it in.

use super::*;

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
    fs::write(&sentinel, b"pending")?;

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
/// restore, swap the pending DB into place and move the old one to a
/// timestamped safety copy. Errors are logged but non-fatal so a
/// botched restore doesn't keep the app from booting at all.
pub fn apply_pending_restore_if_any(app: &AppHandle) {
    let Ok(app_data) = crate::paths::app_data_dir(app) else {
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

pub(super) fn apply_pending_restore(
    app_data: &Path,
    pending: &Path,
    sentinel: &Path,
) -> AppResult<()> {
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
