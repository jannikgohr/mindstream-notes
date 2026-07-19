use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::db::Db;
use crate::error::AppResult;

pub const COLLAB_CREDENTIALS_CHANGED_EVENT: &str = "collab-credentials-changed";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CollabCredentialsChangedEvent {
    pub note_ids: Vec<String>,
}

pub(crate) fn note_ids_for_share_scope(db: &Db, share_scope_id: &str) -> AppResult<Vec<String>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id
               FROM notes
              WHERE share_scope_id = ?1
              ORDER BY id",
        )?;
        let ids = stmt
            .query_map(params![share_scope_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    })
}

pub(crate) fn emit_collab_credentials_changed(app: &AppHandle, mut note_ids: Vec<String>) {
    note_ids.sort();
    note_ids.dedup();
    if note_ids.is_empty() {
        return;
    }
    let event = CollabCredentialsChangedEvent { note_ids };
    if let Err(err) = app.emit(COLLAB_CREDENTIALS_CHANGED_EVENT, event) {
        log::warn!("[collab] failed to emit {COLLAB_CREDENTIALS_CHANGED_EVENT}: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory_for_tests;

    #[test]
    fn note_ids_for_share_scope_returns_only_scoped_notes_in_stable_order() {
        let db = open_memory_for_tests();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO notes(id, title, body, position, created, modified, share_scope_id)
                 VALUES ('z_note', 'Z', '', 0, 't', 't', 'scope_1')",
                [],
            )?;
            conn.execute(
                "INSERT INTO notes(id, title, body, position, created, modified, share_scope_id)
                 VALUES ('a_note', 'A', '', 0, 't', 't', 'scope_1')",
                [],
            )?;
            conn.execute(
                "INSERT INTO notes(id, title, body, position, created, modified, share_scope_id)
                 VALUES ('other', 'Other', '', 0, 't', 't', 'scope_2')",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        let ids = note_ids_for_share_scope(&db, "scope_1").unwrap();

        assert_eq!(ids, vec!["a_note", "z_note"]);
    }
}
