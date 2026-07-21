use super::*;
use crate::collections::{create as create_collection, CreateCollection};
use crate::db::open_memory_for_tests;

fn empty_note(db: &Db, parent: Option<String>) -> Note {
    db.with_conn(|c| {
        create(
            c,
            CreateNote {
                title: Some("Hello".into()),
                body: Some("# Body".into()),
                parent_collection_id: parent,
                note_kind: None,
            },
        )
    })
    .unwrap()
}

#[test]
fn create_then_load_round_trip() {
    let db = open_memory_for_tests();
    let n = empty_note(&db, None);
    let loaded = db.with_conn(|c| load(c, &n.summary.id)).unwrap();
    assert_eq!(loaded.summary.title, "Hello");
    assert_eq!(loaded.body, "# Body");
    assert!(loaded.summary.parent_collection_id.is_none());
    assert!(!loaded.summary.trashed);
}

#[test]
fn save_updates_body_and_modified_changes() {
    let db = open_memory_for_tests();
    let n = empty_note(&db, None);
    let original_modified = n.summary.modified.clone();
    // sleep one millisecond so the second timestamp differs
    std::thread::sleep(std::time::Duration::from_millis(5));
    db.with_conn_mut(|c| {
        update(
            c,
            UpdateNote {
                id: n.summary.id.clone(),
                title: None,
                body: Some("# New body".into()),
                parent_collection_id: None,
                position: None,
                tags: None,
                yrs_state: None,
                favourite: None,
            },
        )
    })
    .unwrap();
    let loaded = db.with_conn(|c| load(c, &n.summary.id)).unwrap();
    assert_eq!(loaded.body, "# New body");
    assert_ne!(loaded.summary.modified, original_modified);
}

#[test]
fn move_note_into_collection_then_back_to_root() {
    let db = open_memory_for_tests();
    let coll = db
        .with_conn(|c| {
            create_collection(
                c,
                CreateCollection {
                    name: "Folder".into(),
                    parent_collection_id: None,
                },
            )
        })
        .unwrap();
    let n = empty_note(&db, None);

    // Move into folder.
    db.with_conn_mut(|c| {
        update(
            c,
            UpdateNote {
                id: n.summary.id.clone(),
                title: None,
                body: None,
                position: None,
                tags: None,
                parent_collection_id: Some(Some(coll.id.clone())),
                yrs_state: None,
                favourite: None,
            },
        )
    })
    .unwrap();
    let l = db.with_conn(|c| load(c, &n.summary.id)).unwrap();
    assert_eq!(
        l.summary.parent_collection_id.as_deref(),
        Some(coll.id.as_str())
    );

    // Move back to root via Some(None).
    db.with_conn_mut(|c| {
        update(
            c,
            UpdateNote {
                id: n.summary.id.clone(),
                title: None,
                body: None,
                position: None,
                tags: None,
                parent_collection_id: Some(None),
                yrs_state: None,
                favourite: None,
            },
        )
    })
    .unwrap();
    let l = db.with_conn(|c| load(c, &n.summary.id)).unwrap();
    assert!(
        l.summary.parent_collection_id.is_none(),
        "move-to-root must clear parent"
    );
}

#[test]
fn trash_excludes_from_default_listing() {
    let db = open_memory_for_tests();
    let n = empty_note(&db, None);
    db.with_conn(|c| trash(c, &n.summary.id)).unwrap();
    let listed = db.with_conn(|c| list(c, false)).unwrap();
    assert!(listed.iter().all(|x| x.id != n.summary.id));
    let listed_with = db.with_conn(|c| list(c, true)).unwrap();
    assert!(listed_with
        .iter()
        .any(|x| x.id == n.summary.id && x.trashed));
}

#[test]
fn restore_then_purge() {
    let db = open_memory_for_tests();
    let n = empty_note(&db, None);
    db.with_conn(|c| trash(c, &n.summary.id)).unwrap();
    db.with_conn(|c| restore(c, &n.summary.id)).unwrap();
    let loaded = db.with_conn(|c| load(c, &n.summary.id)).unwrap();
    assert!(!loaded.summary.trashed);
    db.with_conn(|c| purge(c, &n.summary.id)).unwrap();
    let res = db.with_conn(|c| load(c, &n.summary.id));
    assert!(res.is_err(), "purged note must be gone");
}

#[test]
fn save_with_tags_persists_them() {
    let db = open_memory_for_tests();
    let n = empty_note(&db, None);
    db.with_conn_mut(|c| {
        update(
            c,
            UpdateNote {
                id: n.summary.id.clone(),
                title: None,
                body: None,
                position: None,
                parent_collection_id: None,
                tags: Some(vec!["work".into(), "urgent".into()]),
                yrs_state: None,
                favourite: None,
            },
        )
    })
    .unwrap();
    let loaded = db.with_conn(|c| load(c, &n.summary.id)).unwrap();
    assert_eq!(
        loaded.summary.tags,
        vec!["urgent".to_string(), "work".to_string()]
    );
}

fn dirty_flag(db: &Db, id: &str) -> i64 {
    db.with_conn(|c| {
        Ok(
            c.query_row("SELECT dirty FROM notes WHERE id = ?1", params![id], |r| {
                r.get::<_, i64>(0)
            })?,
        )
    })
    .unwrap()
}

#[test]
fn create_marks_note_dirty_with_empty_yrs_state() {
    // Post-collab: notes::create no longer pre-seeds the yrs_state.
    // The live editor hydrates a fresh y-prosemirror Doc from `body`
    // on first open and writes back a v2 state through update().
    // Until then we just want dirty=1 so the periodic push picks it up.
    let db = open_memory_for_tests();
    let n = empty_note(&db, None);
    assert_eq!(dirty_flag(&db, &n.summary.id), 1);
    let state: Vec<u8> = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT yrs_state FROM notes WHERE id = ?1",
                params![n.summary.id],
                |r| r.get::<_, Option<Vec<u8>>>(0),
            )?
            .unwrap_or_default())
        })
        .unwrap();
    assert!(state.is_empty(), "yrs_state stays empty until first edit");
}

#[test]
fn collab_save_path_writes_state_and_bumps_schema() {
    // When the live editor supplies yrs_state, update() takes the
    // bytes verbatim (no markdown diff) and flips payload_schema to 2.
    let db = open_memory_for_tests();
    let n = empty_note(&db, None);
    let supplied = vec![0xCA, 0xFE, 0xBA, 0xBE];
    db.with_conn_mut(|c| {
        update(
            c,
            UpdateNote {
                id: n.summary.id.clone(),
                title: None,
                body: Some("body via collab".into()),
                parent_collection_id: None,
                position: None,
                tags: None,
                yrs_state: Some(supplied.clone()),
                favourite: None,
            },
        )
    })
    .unwrap();
    let (state, schema) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT yrs_state, payload_schema FROM notes WHERE id = ?1",
                params![n.summary.id],
                |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, i64>(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(state, supplied);
    assert_eq!(schema, 2);
}

#[test]
fn ink_save_path_merges_yrs_state_and_marks_dirty() {
    // Two concurrent edits forked from the same base. `save_yrs_state`
    // must merge them into the existing row rather than overwriting,
    // and re-mark the row dirty so sync picks up the merged result.
    let db = open_memory_for_tests();
    let n = db
        .with_conn(|c| {
            create(
                c,
                CreateNote {
                    title: Some("Ink".into()),
                    body: None,
                    parent_collection_id: None,
                    note_kind: Some("ink".into()),
                },
            )
        })
        .unwrap();

    db.with_conn(|c| {
        Ok(c.execute(
            "UPDATE notes SET dirty = 0 WHERE id = ?1",
            params![n.summary.id],
        )?)
    })
    .unwrap();
    assert_eq!(dirty_flag(&db, &n.summary.id), 0);

    let base = crate::sync::yrs_doc::init_with_markdown("base");
    let edit_a = crate::sync::yrs_doc::apply_local_edit(&base, "base", "base A");
    let edit_b = crate::sync::yrs_doc::apply_local_edit(&base, "base", "base B");
    db.with_conn_mut(|c| save_yrs_state(c, &n.summary.id, &edit_a))
        .unwrap();
    db.with_conn_mut(|c| save_yrs_state(c, &n.summary.id, &edit_b))
        .unwrap();

    let merged: Vec<u8> = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT yrs_state FROM notes WHERE id = ?1",
                params![n.summary.id],
                |r| r.get::<_, Vec<u8>>(0),
            )?)
        })
        .unwrap();
    let merged_text = crate::sync::yrs_doc::to_markdown(&merged);
    assert!(merged_text.contains('A'), "lost edit_a in merged state");
    assert!(merged_text.contains('B'), "lost edit_b in merged state");
    assert_eq!(dirty_flag(&db, &n.summary.id), 1);
}

#[test]
fn save_yrs_state_accepts_empty_update_for_fresh_note() {
    let db = open_memory_for_tests();
    let n = db
        .with_conn(|c| {
            create(
                c,
                CreateNote {
                    title: Some("Ink".into()),
                    body: None,
                    parent_collection_id: None,
                    note_kind: Some("ink".into()),
                },
            )
        })
        .unwrap();

    db.with_conn_mut(|c| save_yrs_state(c, &n.summary.id, &[]))
        .unwrap();

    assert!(db
        .with_conn(|c| load_yrs_state(c, &n.summary.id))
        .unwrap()
        .is_empty());
    assert_eq!(dirty_flag(&db, &n.summary.id), 1);
}

#[test]
fn save_yrs_state_keeps_existing_state_when_incoming_bytes_are_empty() {
    let db = open_memory_for_tests();
    let n = db
        .with_conn(|c| {
            create(
                c,
                CreateNote {
                    title: Some("Ink".into()),
                    body: None,
                    parent_collection_id: None,
                    note_kind: Some("ink".into()),
                },
            )
        })
        .unwrap();

    let base = crate::sync::yrs_doc::init_with_markdown("base");
    let edit = crate::sync::yrs_doc::apply_local_edit(&base, "base", "base A");
    db.with_conn_mut(|c| save_yrs_state(c, &n.summary.id, &edit))
        .unwrap();
    db.with_conn_mut(|c| save_yrs_state(c, &n.summary.id, &[]))
        .unwrap();

    let merged = db.with_conn(|c| load_yrs_state(c, &n.summary.id)).unwrap();
    let merged_text = crate::sync::yrs_doc::to_markdown(&merged);
    assert!(merged_text.contains('A'));
    assert_eq!(dirty_flag(&db, &n.summary.id), 1);
}

#[test]
fn load_yrs_state_returns_empty_for_missing_note() {
    let db = open_memory_for_tests();
    let state = db.with_conn(|c| load_yrs_state(c, "missing-note")).unwrap();
    assert!(state.is_empty());
}

#[test]
fn body_edit_re_marks_dirty_and_updates_yrs_state() {
    let db = open_memory_for_tests();
    let n = empty_note(&db, None);
    // Pretend we just synced this row: clear dirty + capture state.
    db.with_conn(|c| {
        Ok(c.execute(
            "UPDATE notes SET dirty = 0 WHERE id = ?1",
            params![n.summary.id],
        )?)
    })
    .unwrap();
    assert_eq!(dirty_flag(&db, &n.summary.id), 0);

    db.with_conn_mut(|c| {
        update(
            c,
            UpdateNote {
                id: n.summary.id.clone(),
                title: None,
                body: Some("# Body, edited".into()),
                parent_collection_id: None,
                position: None,
                tags: None,
                yrs_state: None,
                favourite: None,
            },
        )
    })
    .unwrap();
    assert_eq!(
        dirty_flag(&db, &n.summary.id),
        1,
        "edit must re-mark the note dirty"
    );
}

/// End-to-end regression: serialize an UpdateNote with parent_collection_id=null
/// and confirm Rust accepts it as Some(None) (the "move to root" intent).
#[test]
fn serde_null_parent_means_move_to_root() {
    let json = r#"{"id":"x","parent_collection_id":null}"#;
    let parsed: UpdateNote = serde_json::from_str(json).unwrap();
    assert_eq!(parsed.parent_collection_id, Some(None));
}

#[test]
fn deleting_a_collection_cascades_to_its_notes() {
    // Regression: previously notes' parent_collection_id had ON DELETE
    // SET NULL, so deleting a folder silently relocated its notes to
    // the root. We now expect them to disappear with the folder.
    let db = open_memory_for_tests();
    let coll = db
        .with_conn(|c| {
            crate::collections::create(
                c,
                crate::collections::CreateCollection {
                    name: "Doomed".into(),
                    parent_collection_id: None,
                },
            )
        })
        .unwrap();
    let n1 = empty_note(&db, Some(coll.id.clone()));
    let n2 = empty_note(&db, Some(coll.id.clone()));

    db.with_conn(|c| crate::collections::delete(c, &coll.id))
        .unwrap();

    let listed = db.with_conn(|c| list(c, true)).unwrap();
    assert!(
        listed.iter().all(|x| x.id != n1.summary.id),
        "n1 should have been cascaded"
    );
    assert!(
        listed.iter().all(|x| x.id != n2.summary.id),
        "n2 should have been cascaded"
    );
}

#[test]
fn moving_a_collection_does_not_delete_its_notes() {
    // The 'trash a folder' UX path moves the folder by updating its
    // parent — children should ride along, not get cascade-deleted.
    let db = open_memory_for_tests();
    let coll = db
        .with_conn(|c| {
            crate::collections::create(
                c,
                crate::collections::CreateCollection {
                    name: "Will be trashed".into(),
                    parent_collection_id: None,
                },
            )
        })
        .unwrap();
    let note = empty_note(&db, Some(coll.id.clone()));

    db.with_conn(|c| {
        crate::collections::update(
            c,
            crate::collections::UpdateCollection {
                id: coll.id.clone(),
                name: None,
                parent_collection_id: Some(Some("trash".into())),
                position: None,
            },
        )
    })
    .unwrap();

    let loaded = db.with_conn(|c| load(c, &note.summary.id)).unwrap();
    assert_eq!(
        loaded.summary.parent_collection_id.as_deref(),
        Some(coll.id.as_str()),
        "note should still belong to its (now trashed) folder"
    );
}

#[test]
fn purging_note_with_synced_assets_queues_asset_tombstones() {
    // When a freeform note is purged, every asset row owned by that
    // note has been queued as a server-side delete BEFORE the
    // ON DELETE CASCADE wipes the asset rows. Without this, synced
    // assets would linger on the Etebase server forever after the
    // note that owned them is gone.
    let db = open_memory_for_tests();
    let note = empty_note(&db, None);

    // Two assets: one previously pushed (has etebase_uid), one local
    // only. Only the pushed one should produce a tombstone.
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO assets(id, owning_note_id, mime_type, bytes,
                                size, created, modified, etebase_uid)
             VALUES (?1, ?2, 'image/png', X'89504E47', 4,
                     '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z',
                     'eb-uid-synced')",
            params!["asset_synced", note.summary.id],
        )?;
        c.execute(
            "INSERT INTO assets(id, owning_note_id, mime_type, bytes,
                                size, created, modified, etebase_uid)
             VALUES (?1, ?2, 'image/png', X'89504E47', 4,
                     '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z',
                     NULL)",
            params!["asset_local_only", note.summary.id],
        )?;
        Ok(())
    })
    .unwrap();

    db.with_conn(|c| purge(c, &note.summary.id)).unwrap();

    let tombstones: Vec<String> = db
        .with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT etebase_uid FROM tombstones WHERE kind = 'asset' ORDER BY etebase_uid",
            )?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .unwrap();
    assert_eq!(
        tombstones,
        vec!["eb-uid-synced".to_string()],
        "only the previously-pushed asset should produce a tombstone"
    );

    // And the cascade should have happened.
    let any_assets_left: i64 = db
        .with_conn(|c| Ok(c.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(any_assets_left, 0, "FK cascade should wipe asset rows");
}

fn note_scope(db: &Db, id: &str) -> Option<String> {
    db.with_conn(|c| crate::sharing::note_scope(c, id)).unwrap()
}

/// Create a folder already stamped with `scope` (the note paths only read a
/// parent's `share_scope_id`, so the full share-root marking isn't needed).
fn scoped_folder(db: &Db, name: &str, scope: &str) -> String {
    let folder = db
        .with_conn(|c| {
            create_collection(
                c,
                CreateCollection {
                    name: name.into(),
                    parent_collection_id: None,
                },
            )
        })
        .unwrap();
    db.with_conn(|c| {
        c.execute(
            "UPDATE collections SET share_scope_id = ?1 WHERE id = ?2",
            params![scope, folder.id],
        )?;
        Ok::<(), AppError>(())
    })
    .unwrap();
    folder.id
}

fn move_note(db: &Db, id: &str, parent: Option<&str>) {
    db.with_conn_mut(|c| {
        update(
            c,
            UpdateNote {
                id: id.into(),
                title: None,
                body: None,
                parent_collection_id: Some(parent.map(str::to_string)),
                position: None,
                tags: None,
                yrs_state: None,
                favourite: None,
            },
        )
    })
    .unwrap();
}

#[test]
fn create_note_inherits_parent_share_scope() {
    let db = open_memory_for_tests();
    let folder = scoped_folder(&db, "Shared", "scope_1");
    let scoped = empty_note(&db, Some(folder));
    let vault = empty_note(&db, None);

    assert_eq!(
        note_scope(&db, &scoped.summary.id).as_deref(),
        Some("scope_1")
    );
    assert_eq!(note_scope(&db, &vault.summary.id), None);
}

#[test]
fn moving_a_note_into_a_share_rehomes_it() {
    let db = open_memory_for_tests();
    let folder = scoped_folder(&db, "Shared", "scope_1");
    let note = empty_note(&db, None);
    assert_eq!(note_scope(&db, &note.summary.id), None);

    move_note(&db, &note.summary.id, Some(&folder));
    assert_eq!(
        note_scope(&db, &note.summary.id).as_deref(),
        Some("scope_1")
    );
}

#[test]
fn moving_a_note_out_of_a_share_rehomes_note_and_assets_and_tombstones() {
    let db = open_memory_for_tests();
    let folder = scoped_folder(&db, "Shared", "scope_1");
    let note = empty_note(&db, Some(folder));
    // Simulate a note + asset that were already pushed into the scope
    // collection, so leaving the scope must tombstone them there.
    db.with_conn(|c| {
        c.execute(
            "UPDATE notes SET etebase_uid = 'scope_note', share_scope_id = 'scope_1' WHERE id = ?1",
            params![note.summary.id],
        )?;
        c.execute(
            "INSERT INTO assets(id, owning_note_id, mime_type, bytes, size, created, modified, etebase_uid, share_scope_id, dirty)
             VALUES ('a1', ?1, 'image/png', x'00', 1, 't', 't', 'scope_asset', 'scope_1', 0)",
            params![note.summary.id],
        )?;
        Ok::<(), AppError>(())
    })
    .unwrap();

    move_note(&db, &note.summary.id, None);

    // Both note and asset re-home to the vault (NULL scope) and detach.
    assert_eq!(note_scope(&db, &note.summary.id), None);
    let (asset_scope, asset_uid): (Option<String>, Option<String>) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT share_scope_id, etebase_uid FROM assets WHERE id = 'a1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(asset_scope, None);
    assert!(asset_uid.is_none(), "asset must detach from its scope uid");

    // Deletes for the old scope copies are queued against scope_1.
    let tombstones: Vec<(String, Option<String>)> = db
        .with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT etebase_uid, share_scope_id FROM tombstones ORDER BY etebase_uid",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .unwrap();
    assert_eq!(
        tombstones,
        vec![
            ("scope_asset".to_string(), Some("scope_1".to_string())),
            ("scope_note".to_string(), Some("scope_1".to_string())),
        ],
        "leaving a scope must delete the note + asset in that scope"
    );
}
