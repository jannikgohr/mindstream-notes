//! Trash queries and deletion shared by native and browser storage.
use crate::collections::TRASH_ID;
use crate::error::AppResult;
use rusqlite::{params, Connection};
use serde::Serialize;
#[derive(Debug, Clone, Serialize)]
pub struct TrashCounts {
    pub notes: u32,
    pub folders: u32,
}
pub fn counts(conn: &Connection) -> AppResult<TrashCounts> {
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

pub fn empty(conn: &mut Connection) -> AppResult<TrashCounts> {
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
            crate::tombstones::queue_tombstone(&tx, "note", &uid)?;
        }
        let mut stmt = tx.prepare(
            "SELECT etebase_uid FROM assets
              WHERE owning_note_id = ?1 AND etebase_uid IS NOT NULL",
        )?;
        let uids = stmt.query_map(params![id], |r| r.get::<_, String>(0))?;
        for uid in uids {
            crate::tombstones::queue_tombstone(&tx, "asset", &uid?)?;
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
            crate::tombstones::queue_tombstone(&tx, "folder", &uid)?;
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
