//! Native adapters for shared signatures storage.
use crate::db::Db;
use crate::error::{AppResult, CommandResult};
pub use mindstream_storage_core::signatures::*;
use rusqlite::Connection;

pub fn list(conn: &Connection) -> AppResult<Vec<SignatureRecord>> {
    mindstream_storage_core::signatures::list(conn).map_err(Into::into)
}

pub fn load(conn: &Connection, id: &str) -> AppResult<SignatureRecord> {
    mindstream_storage_core::signatures::load(conn, id).map_err(Into::into)
}

pub fn upsert(conn: &Connection, input: SaveSignature) -> AppResult<SignatureRecord> {
    mindstream_storage_core::signatures::upsert(conn, input).map_err(Into::into)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    mindstream_storage_core::signatures::delete(conn, id).map_err(Into::into)
}

#[tauri::command]
#[allow(clippy::redundant_closure)]
pub fn list_signatures(db: tauri::State<'_, Db>) -> CommandResult<Vec<SignatureRecord>> {
    db.with_conn(|c| list(c)).map_err(Into::into)
}

#[tauri::command]
pub fn save_signature(
    db: tauri::State<'_, Db>,
    input: SaveSignature,
) -> CommandResult<SignatureRecord> {
    db.with_conn(|c| upsert(c, input)).map_err(Into::into)
}

#[tauri::command]
pub fn delete_signature(db: tauri::State<'_, Db>, id: String) -> CommandResult<()> {
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

        let all = db.with_conn(list).unwrap();
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
        let all = db.with_conn(list).unwrap();
        assert_eq!(all.len(), 1, "upsert replaces, not duplicates");
    }

    #[test]
    fn delete_unpushed_leaves_no_tombstone() {
        let db = open_memory_for_tests();
        save(&db, "sig_1", r#"{}"#);
        db.with_conn(|c| delete(c, "sig_1")).unwrap();
        let all = db.with_conn(list).unwrap();
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
