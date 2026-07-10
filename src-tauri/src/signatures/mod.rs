//! Reusable signature library.
//!
//! A signature is a drawn snapshot the user can re-apply to any PDF note.
//! They're user-global (not tied to a note), so they live in their own
//! table rather than inside a note's Yjs state. The table carries the same
//! `dirty` / `etebase_uid` / `etebase_etag` columns as `assets`, and the
//! sync engine (sync/mod.rs) pushes/pulls each row as its own item in a
//! `mindstream.signatures` Etebase collection — so the library follows the
//! user across devices instead of being stranded in one browser's
//! localStorage.
//!
//! The `data` column is opaque JSON owned by the frontend
//! (`PdfSignatureSnapshot` minus its `id`): `{ width, height, strokes[] }`.
//! Keeping it opaque here means the stroke shape can evolve without a DB
//! migration.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignatureRecord {
    pub id: String,
    /// Opaque JSON: `{ width, height, strokes[] }`. The frontend parses
    /// this and re-attaches `id` to rebuild a `PdfSignatureSnapshot`.
    pub data: String,
    pub created: String,
    pub modified: String,
    /// True once pushed to the remote (i.e. has an `etebase_uid`). Mirrors
    /// the same field on `AssetSummary` / `NoteSummary`.
    pub pushed: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SaveSignature {
    pub id: String,
    pub data: String,
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<SignatureRecord> {
    let etebase_uid: Option<String> = row.get("etebase_uid")?;
    Ok(SignatureRecord {
        id: row.get("id")?,
        data: row.get("data")?,
        created: row.get("created")?,
        modified: row.get("modified")?,
        pushed: etebase_uid.is_some(),
    })
}

pub fn list(conn: &Connection) -> AppResult<Vec<SignatureRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, data, created, modified, etebase_uid
         FROM signatures ORDER BY created",
    )?;
    let rows = stmt.query_map([], row_to_record)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn load(conn: &Connection, id: &str) -> AppResult<SignatureRecord> {
    let mut stmt = conn.prepare(
        "SELECT id, data, created, modified, etebase_uid
         FROM signatures WHERE id = ?1",
    )?;
    stmt.query_row(params![id], row_to_record)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("signature {id}")))
}

/// Insert a new signature or replace an existing one's geometry. Either way
/// the row is marked dirty so the next sync pushes it. `created` is set on
/// first insert and preserved on update.
pub fn upsert(conn: &Connection, input: SaveSignature) -> AppResult<SignatureRecord> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO signatures(id, data, created, modified, dirty)
         VALUES (?1, ?2, ?3, ?3, 1)
         ON CONFLICT(id) DO UPDATE SET
             data     = excluded.data,
             modified = excluded.modified,
             dirty    = 1",
        params![input.id, input.data, now],
    )?;
    load(conn, &input.id)
}

/// Delete a signature and, if it had been pushed, queue a tombstone so the
/// remote item is removed on the next sync. Idempotent — deleting an
/// unknown id is a no-op.
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let etebase_uid: Option<String> = conn
        .query_row(
            "SELECT etebase_uid FROM signatures WHERE id = ?1",
            params![id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    if let Some(uid) = etebase_uid {
        crate::sync::queue_tombstone(conn, "signature", &uid)?;
    }
    conn.execute("DELETE FROM signatures WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------- Tauri commands ----------

#[tauri::command]
#[allow(clippy::redundant_closure)]
pub fn list_signatures(db: tauri::State<'_, Db>) -> Result<Vec<SignatureRecord>, String> {
    db.with_conn(|c| list(c)).map_err(Into::into)
}

#[tauri::command]
pub fn save_signature(
    db: tauri::State<'_, Db>,
    input: SaveSignature,
) -> Result<SignatureRecord, String> {
    db.with_conn(|c| upsert(c, input)).map_err(Into::into)
}

#[tauri::command]
pub fn delete_signature(db: tauri::State<'_, Db>, id: String) -> Result<(), String> {
    db.with_conn(|c| delete(c, &id)).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory_for_tests;

    fn save(db: &Db, id: &str, data: &str) -> SignatureRecord {
        db.with_conn(|c| {
            upsert(
                c,
                SaveSignature {
                    id: id.into(),
                    data: data.into(),
                },
            )
        })
        .unwrap()
    }

    #[test]
    fn upsert_then_list_round_trip() {
        let db = open_memory_for_tests();
        let rec = save(&db, "sig_1", r#"{"width":200,"height":80,"strokes":[]}"#);
        assert_eq!(rec.id, "sig_1");
        assert!(!rec.pushed);

        let all = db.with_conn(|c| list(c)).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].data, r#"{"width":200,"height":80,"strokes":[]}"#);
    }

    #[test]
    fn upsert_replaces_data_and_keeps_created() {
        let db = open_memory_for_tests();
        let first = save(&db, "sig_1", r#"{"v":1}"#);
        let second = save(&db, "sig_1", r#"{"v":2}"#);
        assert_eq!(second.created, first.created, "created is preserved");
        assert_eq!(second.data, r#"{"v":2}"#);
        let all = db.with_conn(|c| list(c)).unwrap();
        assert_eq!(all.len(), 1, "upsert replaces, not duplicates");
    }

    #[test]
    fn delete_unpushed_leaves_no_tombstone() {
        let db = open_memory_for_tests();
        save(&db, "sig_1", r#"{}"#);
        db.with_conn(|c| delete(c, "sig_1")).unwrap();
        let all = db.with_conn(|c| list(c)).unwrap();
        assert!(all.is_empty());
        let tombstones: i64 = db
            .with_conn(|c| Ok(c.query_row("SELECT COUNT(*) FROM tombstones", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(tombstones, 0, "no remote uid means no tombstone");
    }

    #[test]
    fn delete_pushed_queues_tombstone() {
        let db = open_memory_for_tests();
        save(&db, "sig_1", r#"{}"#);
        // Simulate a prior successful push.
        db.with_conn(|c| {
            c.execute(
                "UPDATE signatures SET etebase_uid = 'uid_remote', dirty = 0 WHERE id = 'sig_1'",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        db.with_conn(|c| delete(c, "sig_1")).unwrap();

        let queued: i64 = db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT COUNT(*) FROM tombstones WHERE kind = 'signature' AND etebase_uid = 'uid_remote'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(queued, 1, "pushed signature queues a tombstone on delete");
    }
}
