//! Batch operations for mixed file-tree selections.

use std::collections::HashSet;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::collections::{self, TRASH_ID};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::notes;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TreeItemRef {
    Note { id: String },
    Folder { id: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct BatchCounts {
    pub notes: usize,
    pub folders: usize,
}

pub fn move_many_items(
    conn: &mut Connection,
    items: Vec<TreeItemRef>,
    target_collection_id: Option<String>,
) -> AppResult<BatchCounts> {
    let tx = conn.transaction()?;
    let items = normalize_items(&tx, items)?;
    validate_target(&tx, target_collection_id.as_deref())?;
    for item in &items {
        if let TreeItemRef::Folder { id } = item {
            validate_folder_move(&tx, id, target_collection_id.as_deref())?;
        }
    }

    let now = Utc::now().to_rfc3339();
    let mut counts = BatchCounts {
        notes: 0,
        folders: 0,
    };
    for item in items {
        match item {
            TreeItemRef::Note { id } => {
                move_note(&tx, &id, target_collection_id.as_deref(), &now)?;
                counts.notes += 1;
            }
            TreeItemRef::Folder { id } => {
                move_folder(&tx, &id, target_collection_id.as_deref(), &now)?;
                counts.folders += 1;
            }
        }
    }
    tx.commit()?;
    Ok(counts)
}

pub fn purge_many_items(conn: &mut Connection, items: Vec<TreeItemRef>) -> AppResult<BatchCounts> {
    let tx = conn.transaction()?;
    let items = normalize_items(&tx, items)?;
    let mut counts = BatchCounts {
        notes: 0,
        folders: 0,
    };
    for item in items {
        match item {
            TreeItemRef::Note { id } => {
                notes::purge(&tx, &id)?;
                counts.notes += 1;
            }
            TreeItemRef::Folder { id } => {
                collections::delete(&tx, &id)?;
                counts.folders += 1;
            }
        }
    }
    tx.commit()?;
    Ok(counts)
}

fn validate_target(conn: &Connection, target_collection_id: Option<&str>) -> AppResult<()> {
    let Some(target_id) = target_collection_id else {
        return Ok(());
    };
    let exists = conn
        .query_row(
            "SELECT 1 FROM collections WHERE id = ?1",
            params![target_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(AppError::NotFound(format!("collection {target_id}")))
    }
}

fn validate_folder_move(
    conn: &Connection,
    folder_id: &str,
    target_collection_id: Option<&str>,
) -> AppResult<()> {
    if folder_id == TRASH_ID {
        return Err(AppError::InvalidArg(
            "the trash collection cannot be modified".into(),
        ));
    }
    let Some(target_id) = target_collection_id else {
        return Ok(());
    };
    if target_id == folder_id {
        return Err(AppError::InvalidArg(
            "cannot move a collection into itself".into(),
        ));
    }
    if collection_is_under(conn, target_id, folder_id)? {
        return Err(AppError::InvalidArg(
            "cannot move a collection into one of its descendants".into(),
        ));
    }
    Ok(())
}

fn move_note(
    conn: &Connection,
    id: &str,
    target_collection_id: Option<&str>,
    now: &str,
) -> AppResult<()> {
    let changed = conn.execute(
        "UPDATE notes
         SET parent_collection_id = ?1, modified = ?2, dirty = 1
         WHERE id = ?3",
        params![target_collection_id, now, id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("note {id}")));
    }
    collections::stamp_trashed_at_on_parent_change(conn, "notes", id, target_collection_id, now)?;
    Ok(())
}

fn move_folder(
    conn: &Connection,
    id: &str,
    target_collection_id: Option<&str>,
    now: &str,
) -> AppResult<()> {
    let changed = conn.execute(
        "UPDATE collections
         SET parent_collection_id = ?1, modified = ?2, dirty = 1
         WHERE id = ?3",
        params![target_collection_id, now, id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("collection {id}")));
    }
    collections::stamp_trashed_at_on_parent_change(
        conn,
        "collections",
        id,
        target_collection_id,
        now,
    )?;
    Ok(())
}

fn normalize_items(conn: &Connection, items: Vec<TreeItemRef>) -> AppResult<Vec<TreeItemRef>> {
    let selected_folders: HashSet<String> = items
        .iter()
        .filter_map(|item| match item {
            TreeItemRef::Folder { id } => Some(id.clone()),
            TreeItemRef::Note { .. } => None,
        })
        .collect();
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for item in items {
        let key = match &item {
            TreeItemRef::Note { id } => format!("n:{id}"),
            TreeItemRef::Folder { id } => format!("f:{id}"),
        };
        if !seen.insert(key) {
            continue;
        }
        if item_is_covered_by_selected_folder(conn, &item, &selected_folders)? {
            continue;
        }
        normalized.push(item);
    }

    Ok(normalized)
}

fn item_is_covered_by_selected_folder(
    conn: &Connection,
    item: &TreeItemRef,
    selected_folders: &HashSet<String>,
) -> AppResult<bool> {
    match item {
        TreeItemRef::Folder { id } => {
            let Some(parent) = collection_parent(conn, id)? else {
                return Ok(false);
            };
            collection_or_ancestor_is_selected(conn, &parent, selected_folders)
        }
        TreeItemRef::Note { id } => {
            let Some(parent) = note_parent(conn, id)? else {
                return Ok(false);
            };
            collection_or_ancestor_is_selected(conn, &parent, selected_folders)
        }
    }
}

fn collection_or_ancestor_is_selected(
    conn: &Connection,
    collection_id: &str,
    selected_folders: &HashSet<String>,
) -> AppResult<bool> {
    let mut current = Some(collection_id.to_string());
    let mut seen = HashSet::new();
    while let Some(id) = current {
        if !seen.insert(id.clone()) {
            return Ok(false);
        }
        if selected_folders.contains(&id) {
            return Ok(true);
        }
        current = collection_parent(conn, &id)?;
    }
    Ok(false)
}

fn collection_is_under(
    conn: &Connection,
    collection_id: &str,
    ancestor_id: &str,
) -> AppResult<bool> {
    let mut current = Some(collection_id.to_string());
    let mut seen = HashSet::new();
    while let Some(id) = current {
        if !seen.insert(id.clone()) {
            return Ok(false);
        }
        if id == ancestor_id {
            return Ok(true);
        }
        current = collection_parent(conn, &id)?;
    }
    Ok(false)
}

fn collection_parent(conn: &Connection, collection_id: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT parent_collection_id FROM collections WHERE id = ?1",
            params![collection_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

fn note_parent(conn: &Connection, note_id: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT parent_collection_id FROM notes WHERE id = ?1",
            params![note_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

#[tauri::command]
pub fn move_many(
    db: tauri::State<'_, Db>,
    items: Vec<TreeItemRef>,
    target_collection_id: Option<String>,
) -> Result<BatchCounts, String> {
    db.with_conn_mut(|c| move_many_items(c, items, target_collection_id))
        .map_err(Into::into)
}

#[tauri::command]
pub fn trash_many(
    db: tauri::State<'_, Db>,
    items: Vec<TreeItemRef>,
) -> Result<BatchCounts, String> {
    db.with_conn_mut(|c| move_many_items(c, items, Some(TRASH_ID.to_string())))
        .map_err(Into::into)
}

#[tauri::command]
pub fn restore_many(
    db: tauri::State<'_, Db>,
    items: Vec<TreeItemRef>,
) -> Result<BatchCounts, String> {
    db.with_conn_mut(|c| move_many_items(c, items, None))
        .map_err(Into::into)
}

#[tauri::command]
pub fn purge_many(
    db: tauri::State<'_, Db>,
    items: Vec<TreeItemRef>,
) -> Result<BatchCounts, String> {
    db.with_conn_mut(|c| purge_many_items(c, items))
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collections::{create as create_collection, CreateCollection};
    use crate::db::open_memory_for_tests;
    use crate::notes::{create as create_note, CreateNote};

    #[test]
    fn move_many_moves_mixed_items() {
        let db = open_memory_for_tests();
        let source = collection(&db, "Source", None);
        let target = collection(&db, "Target", None);
        let folder = collection(&db, "Folder", Some(source.id.clone()));
        let note = note(&db, Some(source.id.clone()));

        let counts = db
            .with_conn_mut(|conn| {
                move_many_items(
                    conn,
                    vec![
                        TreeItemRef::Folder {
                            id: folder.id.clone(),
                        },
                        TreeItemRef::Note {
                            id: note.summary.id.clone(),
                        },
                    ],
                    Some(target.id.clone()),
                )
            })
            .unwrap();

        assert_eq!(
            counts,
            BatchCounts {
                notes: 1,
                folders: 1
            }
        );
        let folder_parent = db
            .with_conn(|conn| collections::get(conn, &folder.id))
            .unwrap()
            .parent_collection_id;
        let note_parent = db
            .with_conn(|conn| notes::load(conn, &note.summary.id))
            .unwrap()
            .summary
            .parent_collection_id;
        assert_eq!(folder_parent.as_deref(), Some(target.id.as_str()));
        assert_eq!(note_parent.as_deref(), Some(target.id.as_str()));
    }

    #[test]
    fn move_many_ignores_children_when_parent_folder_is_selected() {
        let db = open_memory_for_tests();
        let parent = collection(&db, "Parent", None);
        let child = collection(&db, "Child", Some(parent.id.clone()));
        let nested_note = note(&db, Some(child.id.clone()));
        let target = collection(&db, "Target", None);

        let counts = db
            .with_conn_mut(|conn| {
                move_many_items(
                    conn,
                    vec![
                        TreeItemRef::Folder {
                            id: parent.id.clone(),
                        },
                        TreeItemRef::Folder {
                            id: child.id.clone(),
                        },
                        TreeItemRef::Note {
                            id: nested_note.summary.id.clone(),
                        },
                    ],
                    Some(target.id.clone()),
                )
            })
            .unwrap();

        assert_eq!(
            counts,
            BatchCounts {
                notes: 0,
                folders: 1
            }
        );
        let parent_after = db
            .with_conn(|conn| collections::get(conn, &parent.id))
            .unwrap();
        assert_eq!(
            parent_after.parent_collection_id.as_deref(),
            Some(target.id.as_str())
        );
    }

    #[test]
    fn move_many_rejects_folder_into_descendant() {
        let db = open_memory_for_tests();
        let parent = collection(&db, "Parent", None);
        let child = collection(&db, "Child", Some(parent.id.clone()));

        let err = db
            .with_conn_mut(|conn| {
                move_many_items(
                    conn,
                    vec![TreeItemRef::Folder {
                        id: parent.id.clone(),
                    }],
                    Some(child.id.clone()),
                )
            })
            .unwrap_err()
            .to_string();

        assert!(err.contains("descendants"));
    }

    #[test]
    fn purge_many_removes_mixed_items() {
        let db = open_memory_for_tests();
        let folder = collection(&db, "Folder", None);
        let note = note(&db, None);

        let counts = db
            .with_conn_mut(|conn| {
                purge_many_items(
                    conn,
                    vec![
                        TreeItemRef::Folder {
                            id: folder.id.clone(),
                        },
                        TreeItemRef::Note {
                            id: note.summary.id.clone(),
                        },
                    ],
                )
            })
            .unwrap();

        assert_eq!(
            counts,
            BatchCounts {
                notes: 1,
                folders: 1
            }
        );
        assert!(db
            .with_conn(|conn| collections::get(conn, &folder.id))
            .is_err());
        assert!(db
            .with_conn(|conn| notes::load(conn, &note.summary.id))
            .is_err());
    }

    fn collection(
        db: &crate::db::Db,
        name: &str,
        parent_collection_id: Option<String>,
    ) -> crate::collections::Collection {
        db.with_conn(|conn| {
            create_collection(
                conn,
                CreateCollection {
                    name: name.to_string(),
                    parent_collection_id,
                },
            )
        })
        .unwrap()
    }

    fn note(db: &crate::db::Db, parent_collection_id: Option<String>) -> crate::notes::Note {
        db.with_conn(|conn| {
            create_note(
                conn,
                CreateNote {
                    title: Some("Note".into()),
                    body: None,
                    parent_collection_id,
                    note_kind: None,
                },
            )
        })
        .unwrap()
    }
}
