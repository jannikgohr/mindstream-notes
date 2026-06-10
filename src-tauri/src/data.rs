//! Data & Backup commands surfaced from the Settings dialog's
//! "Data & Backup" panel.
//!
//! For now this covers:
//!   - `open_data_folder` — reveal the directory holding `mindstream.db`
//!     and asset blobs in the OS file manager.
//!   - `trash_counts` / `empty_trash` — the destructive "empty trash"
//!     button. Counts are shown in the confirm dialog so the user knows
//!     what they're about to lose; the purge is one transaction.

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
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    let path_str = dir
        .to_str()
        .ok_or_else(|| "app data dir path is not valid UTF-8".to_string())?;
    // The shell plugin marks `open` as deprecated in favour of
    // tauri-plugin-opener, but we don't depend on opener yet and the
    // shell:allow-open capability is already granted. Migrate when we
    // pull opener in for the broader Data & Backup feature set.
    #[allow(deprecated)]
    app.shell()
        .open(path_str, None)
        .map_err(|e| format!("could not open data folder: {e}"))
}

/// Notes and folders the user would lose by emptying the trash now.
/// Recurses into subfolders — a folder in trash holding 50 notes counts
/// the folder *and* all 50 notes.
#[tauri::command]
pub fn trash_counts(db: tauri::State<'_, Db>) -> Result<TrashCounts, String> {
    db.with_conn(|c| Ok(counts(c)?)).map_err(Into::into)
}

/// Permanently delete every item under the special trash collection.
/// One transaction: gather etebase UIDs → queue tombstones for sync →
/// DELETE. ON DELETE CASCADE on `note_tags` and `assets` does the rest.
#[tauri::command]
pub fn empty_trash(db: tauri::State<'_, Db>) -> Result<TrashCounts, String> {
    db.with_conn_mut(|c| empty(c)).map_err(Into::into)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collections::{
        create as create_collection, update, CreateCollection, UpdateCollection,
    };
    use crate::db::open_memory_for_tests;
    use crate::notes::{create as create_note, CreateNote};

    fn make_folder(db: &Db, name: &str, parent: Option<String>) -> String {
        db.with_conn(|c| {
            create_collection(
                c,
                CreateCollection {
                    name: name.into(),
                    parent_collection_id: parent,
                },
            )
        })
        .unwrap()
        .id
    }

    fn make_note(db: &Db, parent: Option<String>) -> String {
        db.with_conn(|c| {
            create_note(
                c,
                CreateNote {
                    title: Some("n".into()),
                    body: Some("".into()),
                    parent_collection_id: parent,
                    note_kind: None,
                },
            )
        })
        .unwrap()
        .summary
        .id
    }

    fn move_to(db: &Db, id: &str, parent: Option<String>) {
        db.with_conn(|c| {
            update(
                c,
                UpdateCollection {
                    id: id.into(),
                    name: None,
                    parent_collection_id: Some(parent),
                    position: None,
                },
            )
            .map(|_| ())
        })
        .unwrap();
    }

    #[test]
    fn empty_trash_clears_direct_children() {
        let db = open_memory_for_tests();
        let n1 = make_note(&db, Some(TRASH_ID.into()));
        let f1 = make_folder(&db, "f", Some(TRASH_ID.into()));
        let keep = make_note(&db, None);

        let before = db.with_conn(|c| counts(c)).unwrap();
        assert_eq!(before.notes, 1);
        assert_eq!(before.folders, 1);

        let deleted = db.with_conn_mut(|c| empty(c)).unwrap();
        assert_eq!(deleted.notes, 1);
        assert_eq!(deleted.folders, 1);

        let after = db.with_conn(|c| counts(c)).unwrap();
        assert_eq!(after.notes, 0);
        assert_eq!(after.folders, 0);

        // The non-trashed note survives.
        db.with_conn(|c| crate::notes::load(c, &keep)).unwrap();
        // The trashed ones are gone.
        assert!(db.with_conn(|c| crate::notes::load(c, &n1)).is_err());
        assert!(db.with_conn(|c| crate::collections::get(c, &f1)).is_err());
    }

    #[test]
    fn empty_trash_counts_recursive_descendants() {
        let db = open_memory_for_tests();
        // Build a folder outside trash with a note inside, then move
        // the whole thing into trash. The empty operation must count
        // the nested note even though it's two levels deep.
        let outer = make_folder(&db, "outer", None);
        let inner = make_folder(&db, "inner", Some(outer.clone()));
        let _nested = make_note(&db, Some(inner.clone()));
        let _direct = make_note(&db, Some(outer.clone()));
        move_to(&db, &outer, Some(TRASH_ID.into()));

        let c = db.with_conn(|conn| counts(conn)).unwrap();
        assert_eq!(c.folders, 2, "outer + inner");
        assert_eq!(c.notes, 2, "nested + direct");

        db.with_conn_mut(|conn| empty(conn)).unwrap();
        let after = db.with_conn(|conn| counts(conn)).unwrap();
        assert_eq!(after.notes, 0);
        assert_eq!(after.folders, 0);
    }

    #[test]
    fn empty_trash_is_noop_when_trash_is_empty() {
        let db = open_memory_for_tests();
        let _keep = make_note(&db, None);
        let deleted = db.with_conn_mut(|c| empty(c)).unwrap();
        assert_eq!(deleted.notes, 0);
        assert_eq!(deleted.folders, 0);
    }
}
