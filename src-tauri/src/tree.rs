//! Folder and note summaries read from the same SQLite snapshot.
use crate::{
    collections,
    db::Db,
    error::{AppResult, CommandResult},
    notes,
};
use serde::Serialize;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::{Mutex, PoisonError};

#[derive(Serialize)]
pub struct TreeSnapshot {
    collections: Vec<collections::Collection>,
    notes: Vec<notes::NoteSummary>,
}

pub fn snapshot(db: &Db) -> AppResult<TreeSnapshot> {
    db.with_conn_mut(|conn| {
        let tx = conn.transaction()?;
        let result = TreeSnapshot {
            collections: collections::list(&tx)?,
            notes: notes::list(&tx, true)?,
        };
        tx.commit()?;
        Ok(result)
    })
}

/// A hash of the [`snapshot`], to tell whether something the file tree shows
/// has changed. `None` when the snapshot could not be read.
fn fingerprint(db: &Db) -> Option<u64> {
    let json = serde_json::to_vec(&snapshot(db).ok()?).ok()?;
    let mut hasher = DefaultHasher::new();
    json.hash(&mut hasher);
    Some(hasher.finish())
}

/// The tree as a sync last saw it, so that the next sync can tell the window
/// whether to reload it. A sync can change the tree and then fail.
#[derive(Default)]
pub struct TreeWatch(Mutex<Option<u64>>);

impl TreeWatch {
    pub const fn new() -> Self {
        Self(Mutex::new(None))
    }

    /// Whether the tree changed since the last call, or cannot be read.
    pub fn moved(&self, db: &Db) -> bool {
        let now = fingerprint(db);
        let mut last = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let moved = now.is_none() || *last != now;
        *last = now;
        moved
    }
}

#[tauri::command]
pub fn load_tree(db: tauri::State<'_, Db>) -> CommandResult<TreeSnapshot> {
    snapshot(&db).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_includes_nested_and_trashed_notes_without_bodies() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn(|conn| {
            conn.execute("INSERT INTO collections (id, name, position, created, modified) VALUES ('folder', 'Folder', 0, 'now', 'now')", [])?;
            conn.execute("INSERT INTO notes (id, title, body, parent_collection_id, position, created, modified) VALUES ('nested', 'Nested', 'private body', 'folder', 0, 'now', 'now'), ('deleted', 'Deleted', '', 'trash', 0, 'now', 'now')", [])?;
            Ok(())
        }).unwrap();
        let result = snapshot(&db).unwrap();
        assert!(result
            .collections
            .iter()
            .any(|folder| folder.id == "folder"));
        assert!(result
            .notes
            .iter()
            .any(|note| note.id == "nested"
                && note.parent_collection_id.as_deref() == Some("folder")));
        assert!(result.notes.iter().any(|note| note.id == "deleted"));
        let json = serde_json::to_value(result).unwrap();
        assert!(json["notes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|note| note.get("body").is_none()));
    }

    #[test]
    fn fingerprint_moves_only_when_the_tree_does() {
        let db = crate::db::open_memory_for_tests();
        db.with_conn(|conn| {
            conn.execute("INSERT INTO notes (id, title, body, position, created, modified) VALUES ('note', 'Note', 'body', 0, 'now', 'now')", [])?;
            Ok(())
        }).unwrap();
        let before = fingerprint(&db);
        assert!(before.is_some());
        assert_eq!(fingerprint(&db), before);

        // The body is not in the tree.
        db.with_conn(|conn| {
            conn.execute("UPDATE notes SET body = 'edited' WHERE id = 'note'", [])?;
            Ok(())
        })
        .unwrap();
        assert_eq!(fingerprint(&db), before);

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE notes SET dirty = 0, etebase_uid = 'uid' WHERE id = 'note'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        assert_ne!(fingerprint(&db), before);
    }

    #[test]
    fn a_tree_change_is_reported_by_the_next_look_whenever_it_happened() {
        let db = crate::db::open_memory_for_tests();
        let watch = TreeWatch::new();
        assert!(watch.moved(&db));
        assert!(!watch.moved(&db));

        // Pulled by a sync that failed afterwards.
        db.with_conn(|conn| {
            conn.execute("INSERT INTO notes (id, title, body, position, created, modified) VALUES ('note', 'Note', '', 0, 'now', 'now')", [])?;
            Ok(())
        })
        .unwrap();
        assert!(watch.moved(&db));
        assert!(!watch.moved(&db));
    }
}
