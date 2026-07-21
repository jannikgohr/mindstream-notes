//! Data & Backup commands surfaced from the Settings dialog's
//! "Data & Backup" panel.
//!
//! For now this covers:
//!   - `open_data_folder` — reveal the directory holding `mindstream.db`
//!     and asset blobs in the OS file manager.
//!   - `trash_counts` / `empty_trash` — the destructive "empty trash"
//!     button. Counts are shown in the confirm dialog so the user knows
//!     what they're about to lose; the purge is one transaction.
//!   - `set_trash_retention` / `sweep_trash_retention` — periodic and
//!     on-demand retention sweep. The scheduler is a tokio loop modelled
//!     on `sync::scheduler` (same enable/disable atomic pattern); the
//!     JS settings effect feeds it the current `data.trashRetentionDays`
//!     value whenever it changes.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

use crate::collections::TRASH_ID;
use crate::db::Db;
use crate::error::AppResult;
use crate::sync;

/// Counts surfaced in the "Empty trash" confirmation dialog. Folders
/// counts only count actual folders — the notes inside those folders are
/// rolled into `notes`, so the user sees the total damage in one line.
#[derive(Debug, Clone, Serialize)]
pub struct TrashCounts {
    pub notes: u32,
    pub folders: u32,
}

/// Open the directory holding `mindstream.db` in the OS file manager.
/// Resolves the same path the boot code uses ([`AppHandle::path`] →
/// `app_data_dir`); the dir is guaranteed to exist because `Db::open`
/// created it on first launch.
#[tauri::command]
pub fn open_data_folder(app: AppHandle) -> Result<(), String> {
    let dir = crate::paths::app_data_dir(&app)
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    let path_str = dir
        .to_str()
        .ok_or_else(|| "app data dir path is not valid UTF-8".to_string())?;
    open_with_shell(&app, path_str)
}

/// Open an arbitrary directory in the OS file manager. Driven from the
/// JS side with a path the user already picked through a Tauri folder
/// dialog (export destination, backup target), so we trust the caller
/// to hand us a real on-disk path — we just forward to the shell
/// plugin's `open`.
#[tauri::command]
pub fn open_folder(app: AppHandle, path: String) -> Result<(), String> {
    open_with_shell(&app, &path)
}

fn open_with_shell(app: &AppHandle, path: &str) -> Result<(), String> {
    // The shell plugin marks `open` as deprecated in favour of
    // tauri-plugin-opener, but we don't depend on opener yet and the
    // shell:allow-open capability is already granted. Migrate when we
    // pull opener in for the broader Data & Backup feature set.
    #[allow(deprecated)]
    app.shell()
        .open(path, None)
        .map_err(|e| format!("could not open folder: {e}"))
}

/// Notes and folders the user would lose by emptying the trash now.
/// Recurses into subfolders — a folder in trash holding 50 notes counts
/// the folder *and* all 50 notes.
#[tauri::command]
pub fn trash_counts(db: tauri::State<'_, Db>) -> Result<TrashCounts, String> {
    db.with_conn(counts).map_err(Into::into)
}

/// Permanently delete every item under the special trash collection.
/// One transaction: gather etebase UIDs → queue tombstones for sync →
/// DELETE. ON DELETE CASCADE on `note_tags` and `assets` does the rest.
#[tauri::command]
pub fn empty_trash(db: tauri::State<'_, Db>) -> Result<TrashCounts, String> {
    db.with_conn_mut(empty).map_err(Into::into)
}

fn counts(conn: &Connection) -> AppResult<TrashCounts> {
    let folders: u32 = conn.query_row(
        "WITH RECURSIVE trash_descendants(id) AS (
             SELECT id FROM collections WHERE parent_collection_id = ?1
             UNION ALL
             SELECT c.id FROM collections c
               JOIN trash_descendants td ON c.parent_collection_id = td.id
         )
         SELECT COUNT(*) FROM trash_descendants",
        params![TRASH_ID],
        |r| r.get::<_, u32>(0),
    )?;
    let notes: u32 = conn.query_row(
        "WITH RECURSIVE trash_descendants(id) AS (
             SELECT id FROM collections WHERE parent_collection_id = ?1
             UNION ALL
             SELECT c.id FROM collections c
               JOIN trash_descendants td ON c.parent_collection_id = td.id
         )
         SELECT COUNT(*) FROM notes
          WHERE parent_collection_id = ?1
             OR parent_collection_id IN trash_descendants",
        params![TRASH_ID],
        |r| r.get::<_, u32>(0),
    )?;
    Ok(TrashCounts { notes, folders })
}

fn empty(conn: &mut Connection) -> AppResult<TrashCounts> {
    // Snapshot the counts *before* we delete so the value we return
    // reflects what actually went away (caller uses this for the
    // "deleted N notes" toast). Done outside the tx since it's a read.
    let totals = counts(conn)?;

    let tx = conn.transaction()?;

    // Walk the trash subtree once to gather every note id and every
    // folder id under it. Materialising into Vecs lets us reuse the
    // lists for the tombstone pass without re-running the CTE.
    let folder_ids: Vec<String> = {
        let mut stmt = tx.prepare(
            "WITH RECURSIVE trash_descendants(id) AS (
                 SELECT id FROM collections WHERE parent_collection_id = ?1
                 UNION ALL
                 SELECT c.id FROM collections c
                   JOIN trash_descendants td ON c.parent_collection_id = td.id
             )
             SELECT id FROM trash_descendants",
        )?;
        let rows = stmt.query_map(params![TRASH_ID], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let note_ids: Vec<String> = {
        let mut stmt = tx.prepare(
            "WITH RECURSIVE trash_descendants(id) AS (
                 SELECT id FROM collections WHERE parent_collection_id = ?1
                 UNION ALL
                 SELECT c.id FROM collections c
                   JOIN trash_descendants td ON c.parent_collection_id = td.id
             )
             SELECT id FROM notes
              WHERE parent_collection_id = ?1
                 OR parent_collection_id IN trash_descendants",
        )?;
        let rows = stmt.query_map(params![TRASH_ID], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    // Queue server-side deletes for anything that's been pushed. Same
    // pattern as `notes::purge` — read the etebase_uids *before* the
    // DELETE, since the cascade on `assets` would otherwise drop them.
    for id in &note_ids {
        let note_uid: Option<String> = tx
            .query_row(
                "SELECT etebase_uid FROM notes WHERE id = ?1",
                params![id],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten();
        if let Some(uid) = note_uid {
            sync::queue_tombstone(&tx, "note", &uid)?;
        }
        let mut stmt = tx.prepare(
            "SELECT etebase_uid FROM assets
              WHERE owning_note_id = ?1 AND etebase_uid IS NOT NULL",
        )?;
        let uids = stmt.query_map(params![id], |r| r.get::<_, String>(0))?;
        for uid in uids {
            sync::queue_tombstone(&tx, "asset", &uid?)?;
        }
    }
    for id in &folder_ids {
        let folder_uid: Option<String> = tx
            .query_row(
                "SELECT etebase_uid FROM collections WHERE id = ?1",
                params![id],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten();
        if let Some(uid) = folder_uid {
            sync::queue_tombstone(&tx, "folder", &uid)?;
        }
    }

    // Order matters: drop notes first so the cascade from collection
    // deletes doesn't race with our explicit cleanup. (Functionally
    // equivalent either way — the FK cascade would handle the notes —
    // but doing it explicitly keeps the note row count predictable
    // even if a future migration changes the FK action.)
    for id in &note_ids {
        tx.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    }
    for id in &folder_ids {
        tx.execute("DELETE FROM collections WHERE id = ?1", params![id])?;
    }

    tx.commit()?;
    Ok(totals)
}

// ---------- Retention sweep ----------

/// Tokio-driven scheduler that periodically purges trash items older
/// than the user's retention preference. Same enable/disable atomic
/// pattern as [`crate::sync::scheduler::SyncScheduler`]; the JS
/// settings effect drives it via `set_trash_retention`.
///
/// Loop cadence is hardcoded — the value of "how old?" matters, the
/// sweep cost doesn't. An hour is short enough that "30 days" rounds
/// to 30 days and not 30 days + 1 day worth of stale rows.
pub struct TrashRetentionScheduler {
    enabled: AtomicBool,
    days: AtomicU32,
}

impl TrashRetentionScheduler {
    pub fn new() -> Self {
        Self {
            // Start disabled: the JS settings effect fires once on mount
            // with the restored preference. Running before that would
            // sweep against the schema default (30 days) even if the
            // user picked "forever".
            enabled: AtomicBool::new(false),
            days: AtomicU32::new(0),
        }
    }
}

impl Default for TrashRetentionScheduler {
    fn default() -> Self {
        Self::new()
    }
}

const SWEEP_TICK_SECS: u64 = 60 * 60; // 1 hour
const DISABLED_POLL_SECS: u64 = 60;

/// Spawn the periodic retention sweep. Called once during `setup`.
/// Same lifecycle as the sync scheduler: runs for the lifetime of the
/// app and is dropped on shutdown.
pub fn spawn_retention_sweep(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let scheduler = app.state::<TrashRetentionScheduler>();
            let enabled = scheduler.enabled.load(Ordering::Relaxed);
            let days = scheduler.days.load(Ordering::Relaxed);

            if !enabled || days == 0 {
                tokio::time::sleep(Duration::from_secs(DISABLED_POLL_SECS)).await;
                continue;
            }

            let app_for_blocking = app.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                let db = app_for_blocking.state::<Db>();
                db.with_conn_mut(|c| sweep(c, days))
            })
            .await;
            match result {
                Ok(Ok(count)) if count > 0 => {
                    log::info!("[trash-retention] swept {count} items past {days}d");
                }
                Ok(Ok(_)) => {} // nothing to do, stay quiet
                Ok(Err(err)) => {
                    log::warn!("[trash-retention] sweep failed: {err}");
                }
                Err(join_err) => {
                    log::warn!("[trash-retention] sweep task join failed: {join_err}");
                }
            }

            tokio::time::sleep(Duration::from_secs(SWEEP_TICK_SECS)).await;
        }
    });
}

/// Purge every direct trash child whose `trashed_at` is older than the
/// cutoff. Returns the number of top-level items removed (folders count
/// as one each regardless of how many nested items the cascade dropped).
///
/// Reuses the same tombstone-then-DELETE machinery as `empty()` so a
/// retention-aged item lands in the sync layer's outgoing tombstones
/// the same way a manual purge would.
fn sweep(conn: &mut Connection, days: u32) -> AppResult<u32> {
    // Cutoff is "now minus N days" rendered as RFC3339 so the
    // SQLite TEXT comparison on `trashed_at` (also RFC3339) works
    // lexicographically. UTC throughout — same format the rest of
    // the schema uses.
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(days as i64)).to_rfc3339();

    let tx = conn.transaction()?;

    // Top-level items in trash whose stamp is past the cutoff. Nested
    // children are handled by the cascading delete below — we only
    // need to enumerate the direct children that triggered the sweep.
    let folder_ids: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT id FROM collections
              WHERE parent_collection_id = ?1
                AND trashed_at IS NOT NULL
                AND trashed_at < ?2",
        )?;
        let rows = stmt.query_map(params![TRASH_ID, cutoff], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut note_ids: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT id FROM notes
              WHERE parent_collection_id = ?1
                AND trashed_at IS NOT NULL
                AND trashed_at < ?2",
        )?;
        let rows = stmt.query_map(params![TRASH_ID, cutoff], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    // Snapshot the user-visible "top-level" count *before* we widen
    // note_ids to include nested children. The return value reports
    // what the user trashed (folder + N notes), not how many DB rows
    // got deleted under the hood.
    let top_level_count = (folder_ids.len() + note_ids.len()) as u32;

    // Also gather notes nested inside the about-to-be-purged folders —
    // their etebase tombstones need queuing before the cascade drops
    // them. Done as a recursive descent rooted at each folder so we
    // capture grandchildren too.
    for folder_id in &folder_ids {
        let mut stmt = tx.prepare(
            "WITH RECURSIVE folder_descendants(id) AS (
                 SELECT id FROM collections WHERE parent_collection_id = ?1
                 UNION ALL
                 SELECT c.id FROM collections c
                   JOIN folder_descendants fd ON c.parent_collection_id = fd.id
             )
             SELECT id FROM notes
              WHERE parent_collection_id = ?1
                 OR parent_collection_id IN folder_descendants",
        )?;
        let rows = stmt.query_map(params![folder_id], |r| r.get::<_, String>(0))?;
        for row in rows {
            note_ids.push(row?);
        }
    }

    if top_level_count == 0 {
        return Ok(0);
    }

    // Tombstone-then-delete pass mirrors empty().
    for id in &note_ids {
        let note_uid: Option<String> = tx
            .query_row(
                "SELECT etebase_uid FROM notes WHERE id = ?1",
                params![id],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten();
        if let Some(uid) = note_uid {
            sync::queue_tombstone(&tx, "note", &uid)?;
        }
        let mut stmt = tx.prepare(
            "SELECT etebase_uid FROM assets
              WHERE owning_note_id = ?1 AND etebase_uid IS NOT NULL",
        )?;
        let uids = stmt.query_map(params![id], |r| r.get::<_, String>(0))?;
        for uid in uids {
            sync::queue_tombstone(&tx, "asset", &uid?)?;
        }
    }
    for id in &folder_ids {
        let folder_uid: Option<String> = tx
            .query_row(
                "SELECT etebase_uid FROM collections WHERE id = ?1",
                params![id],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten();
        if let Some(uid) = folder_uid {
            sync::queue_tombstone(&tx, "folder", &uid)?;
        }
    }

    for id in &note_ids {
        tx.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    }
    for id in &folder_ids {
        tx.execute("DELETE FROM collections WHERE id = ?1", params![id])?;
    }

    tx.commit()?;
    Ok(top_level_count)
}

// ---------- Retention commands ----------

/// Tell the scheduler what the current retention is. `days = 0`
/// disables it (used for the "forever" option).
#[tauri::command]
pub fn set_trash_retention(scheduler: tauri::State<'_, TrashRetentionScheduler>, days: u32) {
    scheduler.enabled.store(days > 0, Ordering::Relaxed);
    scheduler.days.store(days, Ordering::Relaxed);
}

/// Run the sweep immediately and return how many top-level items it
/// purged. The settings effect calls this once on startup so the user
/// doesn't have to wait up to an hour for the first scheduled tick.
#[tauri::command]
pub fn sweep_trash_retention(db: tauri::State<'_, Db>, days: u32) -> Result<u32, String> {
    if days == 0 {
        return Ok(0);
    }
    db.with_conn_mut(|c| sweep(c, days)).map_err(Into::into)
}

#[cfg(test)]
mod tests;
