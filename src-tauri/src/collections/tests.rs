use super::*;
use crate::db::open_memory_for_tests;

fn create_root(db: &Db, name: &str) -> Collection {
    db.with_conn(|c| {
        create(
            c,
            CreateCollection {
                name: name.into(),
                parent_collection_id: None,
            },
        )
    })
    .unwrap()
}

#[test]
fn create_then_list_returns_the_row() {
    let db = open_memory_for_tests();
    let c = create_root(&db, "Work");
    let list_out = db.with_conn(list).unwrap();
    assert_eq!(list_out.len(), 2);
    assert_eq!(list_out[1].id, c.id);
    assert_eq!(list_out[1].name, "Work");
    assert!(list_out[1].parent_collection_id.is_none());
}

#[test]
fn rename_collection() {
    let db = open_memory_for_tests();
    let c = create_root(&db, "Old");
    db.with_conn(|conn| {
        update(
            conn,
            UpdateCollection {
                id: c.id.clone(),
                name: Some("New".into()),
                parent_collection_id: None,
                position: None,
            },
        )
    })
    .unwrap();
    let fetched = db.with_conn(|conn| get(conn, &c.id)).unwrap();
    assert_eq!(fetched.name, "New");
}

#[test]
fn move_collection_into_another_then_back_to_root() {
    let db = open_memory_for_tests();
    let parent = create_root(&db, "Parent");
    let child = create_root(&db, "Child");

    // Move child under parent.
    db.with_conn(|c| {
        update(
            c,
            UpdateCollection {
                id: child.id.clone(),
                name: None,
                parent_collection_id: Some(Some(parent.id.clone())),
                position: None,
            },
        )
    })
    .unwrap();
    let fetched = db.with_conn(|c| get(c, &child.id)).unwrap();
    assert_eq!(
        fetched.parent_collection_id.as_deref(),
        Some(parent.id.as_str())
    );

    // Move child back to root via Some(None) (the "move to root" regression).
    db.with_conn(|c| {
        update(
            c,
            UpdateCollection {
                id: child.id.clone(),
                name: None,
                parent_collection_id: Some(None),
                position: None,
            },
        )
    })
    .unwrap();
    let fetched = db.with_conn(|c| get(c, &child.id)).unwrap();
    assert!(
        fetched.parent_collection_id.is_none(),
        "move-to-root should clear parent"
    );
}

#[test]
fn cannot_move_collection_into_self() {
    let db = open_memory_for_tests();
    let c = create_root(&db, "X");
    let res = db.with_conn(|conn| {
        update(
            conn,
            UpdateCollection {
                id: c.id.clone(),
                name: None,
                parent_collection_id: Some(Some(c.id.clone())),
                position: None,
            },
        )
    });
    assert!(res.is_err(), "self-parent must be rejected");
}

#[test]
fn cannot_move_collection_into_descendant() {
    let db = open_memory_for_tests();
    let a = create_root(&db, "A");
    // Make B a child of A, then try to move A into B.
    let b = db
        .with_conn(|c| {
            create(
                c,
                CreateCollection {
                    name: "B".into(),
                    parent_collection_id: Some(a.id.clone()),
                },
            )
        })
        .unwrap();
    let res = db.with_conn(|conn| {
        update(
            conn,
            UpdateCollection {
                id: a.id.clone(),
                name: None,
                parent_collection_id: Some(Some(b.id.clone())),
                position: None,
            },
        )
    });
    assert!(
        res.is_err(),
        "moving ancestor into descendant must be rejected"
    );
}

#[test]
fn delete_cascades_to_child_collections() {
    let db = open_memory_for_tests();
    let parent = create_root(&db, "Parent");
    let child = db
        .with_conn(|c| {
            create(
                c,
                CreateCollection {
                    name: "Child".into(),
                    parent_collection_id: Some(parent.id.clone()),
                },
            )
        })
        .unwrap();
    db.with_conn(|c| delete(c, &parent.id)).unwrap();
    let res = db.with_conn(|c| get(c, &child.id));
    assert!(res.is_err(), "child should have been cascaded");
}

#[test]
fn migration_v2_inserts_the_trash_collection() {
    let db = open_memory_for_tests();
    let trash = db.with_conn(|c| get(c, "trash")).expect("trash row");
    assert_eq!(trash.id, "trash");
    assert_eq!(trash.name, "Trash");
    assert!(trash.parent_collection_id.is_none());
}

#[test]
fn cannot_delete_the_trash_collection() {
    let db = open_memory_for_tests();
    let res = db.with_conn(|c| delete(c, "trash"));
    assert!(
        res.is_err(),
        "deleting the trash collection must be rejected"
    );
    // Still present afterwards.
    let trash = db.with_conn(|c| get(c, "trash")).unwrap();
    assert_eq!(trash.id, "trash");
}

#[test]
fn cannot_rename_the_trash_collection() {
    let db = open_memory_for_tests();
    let res = db.with_conn(|c| {
        update(
            c,
            UpdateCollection {
                id: "trash".into(),
                name: Some("Rubbish bin".into()),
                parent_collection_id: None,
                position: None,
            },
        )
    });
    assert!(
        res.is_err(),
        "renaming the trash collection must be rejected"
    );
}

#[test]
fn cannot_reparent_the_trash_collection() {
    let db = open_memory_for_tests();
    let other = create_root(&db, "Other");
    let res = db.with_conn(|c| {
        update(
            c,
            UpdateCollection {
                id: "trash".into(),
                name: None,
                parent_collection_id: Some(Some(other.id.clone())),
                position: None,
            },
        )
    });
    assert!(res.is_err(), "moving the trash collection must be rejected");
}

fn scope_of(db: &Db, id: &str) -> Option<String> {
    db.with_conn(|c| crate::sharing::collection_scope(c, id))
        .unwrap()
}

/// Turn an existing folder into a share root: stamp the scope + the
/// `share_id` anchor the same way `record_outgoing_share` does, and re-home
/// its (currently empty) subtree so it lives in the scope.
fn make_share_root(db: &Db, id: &str, scope: &str) {
    db.with_conn(|c| {
        crate::sharing::rehome_folder_subtree(c, id, Some(scope))?;
        c.execute(
            "UPDATE collections SET share_id = ?1, shared_by_me = 1 WHERE id = ?2",
            params!["folders_uid", id],
        )?;
        Ok::<(), AppError>(())
    })
    .unwrap();
}

fn move_under(db: &Db, id: &str, parent: Option<&str>) {
    db.with_conn(|c| {
        update(
            c,
            UpdateCollection {
                id: id.into(),
                name: None,
                parent_collection_id: Some(parent.map(str::to_string)),
                position: None,
            },
        )
    })
    .unwrap();
}

#[test]
fn create_inherits_parent_share_scope() {
    let db = open_memory_for_tests();
    let shared = create_root(&db, "Shared");
    make_share_root(&db, &shared.id, "scope_1");

    // A folder created inside the shared root inherits its scope; one created
    // at the vault root stays unscoped.
    let child = db
        .with_conn(|c| {
            create(
                c,
                CreateCollection {
                    name: "Child".into(),
                    parent_collection_id: Some(shared.id.clone()),
                },
            )
        })
        .unwrap();
    let vault = create_root(&db, "Vault");

    assert_eq!(scope_of(&db, &child.id).as_deref(), Some("scope_1"));
    assert_eq!(scope_of(&db, &vault.id), None);
}

#[test]
fn moving_a_folder_into_a_share_rehomes_the_subtree() {
    let db = open_memory_for_tests();
    let shared = create_root(&db, "Shared");
    make_share_root(&db, &shared.id, "scope_1");

    // A vault folder with a nested child, moved under the shared root.
    let folder = create_root(&db, "Folder");
    let nested = db
        .with_conn(|c| {
            create(
                c,
                CreateCollection {
                    name: "Nested".into(),
                    parent_collection_id: Some(folder.id.clone()),
                },
            )
        })
        .unwrap();

    move_under(&db, &folder.id, Some(&shared.id));

    assert_eq!(scope_of(&db, &folder.id).as_deref(), Some("scope_1"));
    assert_eq!(
        scope_of(&db, &nested.id).as_deref(),
        Some("scope_1"),
        "the whole moved subtree should be re-homed"
    );
}

#[test]
fn moving_a_folder_out_of_a_share_rehomes_to_the_vault() {
    let db = open_memory_for_tests();
    let shared = create_root(&db, "Shared");
    make_share_root(&db, &shared.id, "scope_1");
    let child = db
        .with_conn(|c| {
            create(
                c,
                CreateCollection {
                    name: "Child".into(),
                    parent_collection_id: Some(shared.id.clone()),
                },
            )
        })
        .unwrap();
    assert_eq!(scope_of(&db, &child.id).as_deref(), Some("scope_1"));

    // Drag the child out to the vault root — it leaves the scope.
    move_under(&db, &child.id, None);
    assert_eq!(scope_of(&db, &child.id), None);
}

#[test]
fn moving_a_share_root_within_the_vault_keeps_its_scope() {
    let db = open_memory_for_tests();
    let shared = create_root(&db, "Shared");
    make_share_root(&db, &shared.id, "scope_1");
    let other = create_root(&db, "Other"); // unscoped vault folder

    // Relocating the share root under a personal folder must not strip the
    // share — the anchor guard skips the re-home.
    move_under(&db, &shared.id, Some(&other.id));
    assert_eq!(
        scope_of(&db, &shared.id).as_deref(),
        Some("scope_1"),
        "a share root must keep its scope when moved in the owner's tree"
    );
}
