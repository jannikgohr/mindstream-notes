//! Folder and note summaries read from the same SQLite snapshot.
use crate::{
    collections,
    db::Db,
    error::{AppResult, CommandResult},
    notes,
};
use serde::Serialize;

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
}
