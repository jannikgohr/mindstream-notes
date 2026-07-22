use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::app_events::AppEvent;
use crate::db::Db;
use crate::error::AppResult;

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

/// Payload for a credential-rotation notice, or `None` when there is nothing to
/// tell the frontend about. Callers collect note ids from several queries, so
/// the ids arrive unsorted and may repeat — normalise them here (sort + dedup)
/// so a listener sees each note once and in a stable order.
///
/// Split out from the emit below because it holds every decision this event
/// makes; the emit itself is a bare Tauri IPC call.
pub(crate) fn credentials_changed_event(
    mut note_ids: Vec<String>,
) -> Option<CollabCredentialsChangedEvent> {
    note_ids.sort();
    note_ids.dedup();
    if note_ids.is_empty() {
        return None;
    }
    Some(CollabCredentialsChangedEvent { note_ids })
}

pub(crate) fn emit_collab_credentials_changed(app: &AppHandle, note_ids: Vec<String>) {
    let Some(event) = credentials_changed_event(note_ids) else {
        return;
    };
    let event_name = AppEvent::CollabCredentialsChanged.as_str();
    if let Err(err) = app.emit(event_name, event) {
        log::warn!("[collab] failed to emit {event_name}: {err}");
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

    #[test]
    fn note_ids_for_share_scope_is_empty_for_an_unknown_scope() {
        let db = open_memory_for_tests();

        let ids = note_ids_for_share_scope(&db, "missing_scope").unwrap();

        assert!(ids.is_empty());
    }

    #[test]
    fn credentials_changed_event_sorts_and_dedupes_note_ids() {
        let event =
            credentials_changed_event(vec!["n_b".into(), "n_a".into(), "n_b".into(), "n_c".into()])
                .expect("some note ids");

        assert_eq!(event.note_ids, vec!["n_a", "n_b", "n_c"]);
    }

    #[test]
    fn credentials_changed_event_is_none_when_no_notes_are_affected() {
        assert_eq!(credentials_changed_event(Vec::new()), None);
    }
}
