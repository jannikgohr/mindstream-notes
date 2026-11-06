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
fn move_many_rejects_missing_target_collection() {
    let db = open_memory_for_tests();
    let note = note(&db, None);

    let err = db
        .with_conn_mut(|conn| {
            move_many_items(
                conn,
                vec![TreeItemRef::Note {
                    id: note.summary.id.clone(),
                }],
                Some("missing-target".to_string()),
            )
        })
        .unwrap_err()
        .to_string();

    assert!(err.contains("collection missing-target"));
}

#[test]
fn move_many_rejects_moving_the_trash_collection() {
    let db = open_memory_for_tests();
    let target = collection(&db, "Target", None);

    let err = db
        .with_conn_mut(|conn| {
            move_many_items(
                conn,
                vec![TreeItemRef::Folder {
                    id: TRASH_ID.to_string(),
                }],
                Some(target.id.clone()),
            )
        })
        .unwrap_err()
        .to_string();

    assert!(err.contains("trash collection"));
}

#[test]
fn move_many_deduplicates_repeated_items() {
    let db = open_memory_for_tests();
    let target = collection(&db, "Target", None);
    let note = note(&db, None);

    let counts = db
        .with_conn_mut(|conn| {
            move_many_items(
                conn,
                vec![
                    TreeItemRef::Note {
                        id: note.summary.id.clone(),
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
            folders: 0
        }
    );
}

#[test]
fn move_many_restores_items_to_root() {
    let db = open_memory_for_tests();
    let folder = collection(&db, "Folder", Some(TRASH_ID.to_string()));
    let note = note(&db, Some(TRASH_ID.to_string()));

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
                None,
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
    assert!(folder_parent.is_none());
    assert!(note_parent.is_none());
}

fn note_parent_of(db: &Db, id: &str) -> Option<String> {
    db.with_conn(|conn| notes::load(conn, id))
        .unwrap()
        .summary
        .parent_collection_id
}

fn folder_parent_of(db: &Db, id: &str) -> Option<String> {
    db.with_conn(|conn| collections::get(conn, id))
        .unwrap()
        .parent_collection_id
}

fn trash(db: &Db, items: Vec<TreeItemRef>) {
    db.with_conn_mut(|conn| move_many_items(conn, items, Some(TRASH_ID.to_string())))
        .unwrap();
}

fn restore(db: &Db, items: Vec<TreeItemRef>) -> BatchCounts {
    db.with_conn_mut(|conn| restore_many_items(conn, items))
        .unwrap()
}

#[test]
fn restore_puts_items_back_where_they_were_deleted_from() {
    let db = open_memory_for_tests();
    let home = collection(&db, "Home", None);
    let folder = collection(&db, "Folder", Some(home.id.clone()));
    let note = note(&db, Some(home.id.clone()));
    let at_root = self::note(&db, None);
    let items = vec![
        TreeItemRef::Folder {
            id: folder.id.clone(),
        },
        TreeItemRef::Note {
            id: note.summary.id.clone(),
        },
        TreeItemRef::Note {
            id: at_root.summary.id.clone(),
        },
    ];
    trash(&db, items.clone());
    assert_eq!(folder_parent_of(&db, &folder.id).as_deref(), Some(TRASH_ID));

    assert_eq!(
        restore(&db, items),
        BatchCounts {
            notes: 2,
            folders: 1
        }
    );
    assert_eq!(folder_parent_of(&db, &folder.id), Some(home.id.clone()));
    assert_eq!(note_parent_of(&db, &note.summary.id), Some(home.id));
    assert_eq!(note_parent_of(&db, &at_root.summary.id), None);
    let trashed = db
        .with_conn(|conn| notes::load(conn, &note.summary.id))
        .unwrap()
        .summary
        .trashed;
    assert!(!trashed);
}

#[test]
fn restore_falls_back_to_the_root_when_the_folder_is_gone_or_trashed() {
    let db = open_memory_for_tests();
    let gone = collection(&db, "Gone", None);
    let trashed = collection(&db, "Trashed", None);
    let from_gone = note(&db, Some(gone.id.clone()));
    let from_trashed = note(&db, Some(trashed.id.clone()));
    trash(
        &db,
        vec![
            TreeItemRef::Note {
                id: from_gone.summary.id.clone(),
            },
            TreeItemRef::Note {
                id: from_trashed.summary.id.clone(),
            },
        ],
    );
    db.with_conn(|conn| collections::delete(conn, &gone.id))
        .unwrap();
    trash(
        &db,
        vec![TreeItemRef::Folder {
            id: trashed.id.clone(),
        }],
    );

    restore(
        &db,
        vec![
            TreeItemRef::Note {
                id: from_gone.summary.id.clone(),
            },
            TreeItemRef::Note {
                id: from_trashed.summary.id.clone(),
            },
        ],
    );
    assert_eq!(note_parent_of(&db, &from_gone.summary.id), None);
    assert_eq!(note_parent_of(&db, &from_trashed.summary.id), None);
}

#[test]
fn single_restore_and_a_pull_style_move_record_the_folder_too() {
    let db = open_memory_for_tests();
    let home = collection(&db, "Home", None);
    let note = note(&db, Some(home.id.clone()));
    // A pulled delete writes the parent directly, without the batch path.
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE notes SET parent_collection_id = 'trash' WHERE id = ?1",
            params![note.summary.id],
        )
        .map_err(Into::into)
    })
    .unwrap();
    db.with_conn(|conn| notes::restore(conn, &note.summary.id))
        .unwrap();
    assert_eq!(note_parent_of(&db, &note.summary.id), Some(home.id.clone()));

    // The trash command records it as well.
    db.with_conn(|conn| notes::trash(conn, &note.summary.id))
        .unwrap();
    db.with_conn(|conn| notes::restore(conn, &note.summary.id))
        .unwrap();
    assert_eq!(note_parent_of(&db, &note.summary.id), Some(home.id));
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

fn scope_of(db: &Db, table: &str, id: &str) -> Option<String> {
    db.with_conn(|c| {
        Ok(c.query_row(
            &format!("SELECT share_scope_id FROM {table} WHERE id = ?1"),
            params![id],
            |r| r.get::<_, Option<String>>(0),
        )?)
    })
    .unwrap()
}

#[test]
fn batch_move_into_a_share_rehomes_note_and_folder_subtree() {
    let db = open_memory_for_tests();
    let shared = collection(&db, "Shared", None);
    // Mark the destination as a share root (scope + anchor).
    db.with_conn(|c| {
        crate::sharing::rehome_folder_subtree(c, &shared.id, Some("scope_1"))?;
        c.execute(
            "UPDATE collections SET share_id = 'folders_uid', shared_by_me = 1 WHERE id = ?1",
            params![shared.id],
        )?;
        Ok::<(), AppError>(())
    })
    .unwrap();

    let folder = collection(&db, "Folder", None);
    let nested = collection(&db, "Nested", Some(folder.id.clone()));
    let loose = note(&db, None);

    db.with_conn_mut(|c| {
        move_many_items(
            c,
            vec![
                TreeItemRef::Folder {
                    id: folder.id.clone(),
                },
                TreeItemRef::Note {
                    id: loose.summary.id.clone(),
                },
            ],
            Some(shared.id.clone()),
        )
    })
    .unwrap();

    assert_eq!(
        scope_of(&db, "collections", &folder.id).as_deref(),
        Some("scope_1")
    );
    assert_eq!(
        scope_of(&db, "collections", &nested.id).as_deref(),
        Some("scope_1"),
        "batch move must re-home the whole folder subtree"
    );
    assert_eq!(
        scope_of(&db, "notes", &loose.summary.id).as_deref(),
        Some("scope_1")
    );
}
