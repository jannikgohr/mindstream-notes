use super::*;

fn preview(collection_type: &str, name: Option<&str>) -> InvitationPreview {
    InvitationPreview {
        uid: "invite_1".into(),
        username: "recipient".into(),
        sender_username: Some("sender".into()),
        collection_uid: "col_shared".into(),
        access_level: CollectionAccessLevel::ReadWrite,
        collection_type: collection_type.into(),
        collection_name: name.map(str::to_string),
    }
}

#[test]
fn invitation_to_a_shared_folder_is_shown_with_its_name() {
    let share = incoming_share(&preview(COLLECTION_TYPE_SHARED, Some("Trip plans")))
        .expect("an invitation to a shared folder");

    assert_eq!(
        share,
        IncomingShare {
            invitation_id: "invite_1".into(),
            collection_uid: "col_shared".into(),
            name: Some("Trip plans".into()),
            sender_username: Some("sender".into()),
            access_level: ShareAccessLevel::ReadWrite,
        }
    );
}

/// Only a shared folder is ever shared by this app. An invitation to any
/// other kind of collection was made by something else, and showing it as a
/// folder to accept would let that something put a collection of its own
/// choosing among the user's.
#[test]
fn invitation_to_another_kind_of_collection_is_not_a_share() {
    for other in [
        "mindstream.vault",
        "mindstream.share_manifest",
        "mindstream.notes",
        "etebase.vcard",
        "",
    ] {
        assert_eq!(incoming_share(&preview(other, Some("Looks fine"))), None);
    }
}

#[test]
fn invitation_without_a_usable_name_is_shown_without_one() {
    for name in [None, Some(""), Some("   ")] {
        let share = incoming_share(&preview(COLLECTION_TYPE_SHARED, name)).unwrap();
        assert_eq!(share.name, None, "{name:?}");
    }
    let padded = incoming_share(&preview(COLLECTION_TYPE_SHARED, Some("  Recipes ")));
    assert_eq!(padded.unwrap().name.as_deref(), Some("Recipes"));
}

#[test]
fn share_access_level_db_mapping_round_trips() {
    // Misrouting these strings silently downgrades or elevates a share's
    // permission (read_only recipients that can't push, read_write ones
    // locked out of editing), so pin the exact db spelling and the round
    // trip both ways.
    for (level, db) in [
        (ShareAccessLevel::ReadOnly, "read_only"),
        (ShareAccessLevel::ReadWrite, "read_write"),
        (ShareAccessLevel::Admin, "admin"),
    ] {
        assert_eq!(share_access_level_to_db(level), db);
        assert_eq!(share_access_level_from_db(db), Some(level));
    }
    assert_eq!(share_access_level_from_db("editor"), None);
    assert_eq!(share_access_level_from_db(""), None);
}

#[test]
fn share_access_level_collection_access_round_trips() {
    for level in [
        ShareAccessLevel::ReadOnly,
        ShareAccessLevel::ReadWrite,
        ShareAccessLevel::Admin,
    ] {
        let collection: CollectionAccessLevel = level.into();
        assert_eq!(ShareAccessLevel::from(collection), level);
    }
}

#[test]
fn read_only_access_changes_rotate_live_collab_credentials() {
    assert!(access_change_requires_collab_rotation(
        ShareAccessLevel::ReadOnly
    ));
    assert!(!access_change_requires_collab_rotation(
        ShareAccessLevel::ReadWrite
    ));
    assert!(!access_change_requires_collab_rotation(
        ShareAccessLevel::Admin
    ));
}

#[test]
fn rehome_folder_subtree_stamps_detaches_and_tombstones() {
    let db = crate::db::open_memory_for_tests();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position, created, modified, etebase_uid, dirty)
             VALUES ('root', NULL, 'Root', 0, 't', 't', 'vault_root', 0)",
            [],
        )?;
        conn.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position, created, modified, etebase_uid, dirty)
             VALUES ('child', 'root', 'Child', 0, 't', 't', 'vault_child', 0)",
            [],
        )?;
        conn.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position, created, modified, etebase_uid, dirty)
             VALUES ('n1', 'child', 'N1', '', 0, 't', 't', 'vault_n1', 0)",
            [],
        )?;
        // n2 was never pushed (no etebase_uid) — it must still get stamped
        // but queue no tombstone.
        conn.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position, created, modified, dirty)
             VALUES ('n2', 'root', 'N2', '', 0, 't', 't', 0)",
            [],
        )?;
        conn.execute(
            "INSERT INTO assets(id, owning_note_id, mime_type, bytes, size, created, modified, etebase_uid, dirty)
             VALUES ('a1', 'n1', 'image/png', x'00', 1, 't', 't', 'vault_a1', 0)",
            [],
        )?;
        Ok::<(), AppError>(())
    })
    .unwrap();

    db.with_conn(|conn| rehome_folder_subtree(conn, "root", Some("scope_1")))
        .unwrap();

    db.with_conn(|conn| {
        for (table, id) in [
            ("collections", "root"),
            ("collections", "child"),
            ("notes", "n1"),
            ("notes", "n2"),
            ("assets", "a1"),
        ] {
            let (scope, uid, dirty): (Option<String>, Option<String>, i64) = conn.query_row(
                &format!("SELECT share_scope_id, etebase_uid, dirty FROM {table} WHERE id = ?1"),
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            assert_eq!(scope.as_deref(), Some("scope_1"), "{table} {id} scope");
            assert!(uid.is_none(), "{table} {id} etebase_uid must be detached");
            assert_eq!(dirty, 1, "{table} {id} must be dirty");
        }

        // Only the four already-pushed rows get a tombstone, all routed to
        // the vault (share_scope_id NULL) so the old vault items are deleted.
        let mut stmt = conn
            .prepare("SELECT etebase_uid, share_scope_id FROM tombstones ORDER BY etebase_uid")?;
        let rows: Vec<(String, Option<String>)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let uids: Vec<&str> = rows.iter().map(|(u, _)| u.as_str()).collect();
        assert_eq!(uids, ["vault_a1", "vault_child", "vault_n1", "vault_root"]);
        assert!(
            rows.iter().all(|(_, scope)| scope.is_none()),
            "migration tombstones must route to the vault collection"
        );
        Ok::<(), AppError>(())
    })
    .unwrap();
}

fn insert_rehome_note(conn: &rusqlite::Connection, id: &str, folder: Option<&str>) {
    conn.execute(
        "INSERT INTO notes(id, parent_collection_id, title, body, position, created, modified, dirty)
         VALUES (?1, ?2, ?1, '', 0, 't', 't', 0)",
        params![id, folder],
    )
    .unwrap();
}

fn asset_row(
    conn: &rusqlite::Connection,
    id: &str,
) -> (Option<String>, Option<String>, i64, Vec<u8>) {
    conn.query_row(
        "SELECT owning_note_id, share_scope_id, dirty, bytes FROM assets WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )
    .unwrap()
}

#[test]
fn moving_asset_owner_across_scope_keeps_both_notes_assets_accessible() {
    let db = crate::db::open_memory_for_tests();
    db.with_conn(|conn| {
        insert_rehome_note(conn, "owner", None);
        insert_rehome_note(conn, "staying", None);
        let asset = crate::assets::store_deduped(conn, "owner", "image/png", b"shared")?;
        crate::assets::add_ref(conn, &asset.id, "staying")?;
        conn.execute(
            "UPDATE notes SET body = 'asset:mindstream/' || ?1 WHERE id IN ('owner', 'staying')",
            params![asset.id],
        )?;

        rehome_note_subtree(conn, "owner", Some("scope_x"))?;

        let original = asset_row(conn, &asset.id);
        assert_eq!(original.0.as_deref(), Some("staying"));
        assert_eq!(original.1, None);
        assert_eq!(original.2, 1, "re-anchored assets must be pushed again");
        assert_eq!(original.3, b"shared");

        let moved_id: String = conn.query_row(
            "SELECT asset_id FROM asset_refs WHERE note_id = 'owner'",
            [],
            |row| row.get(0),
        )?;
        assert_ne!(moved_id, asset.id);
        let moved = asset_row(conn, &moved_id);
        assert_eq!(moved.0.as_deref(), Some("owner"));
        assert_eq!(moved.1.as_deref(), Some("scope_x"));
        assert_eq!(moved.3, b"shared");

        let staying_body: String =
            conn.query_row("SELECT body FROM notes WHERE id = 'staying'", [], |row| {
                row.get(0)
            })?;
        let moved_body: String =
            conn.query_row("SELECT body FROM notes WHERE id = 'owner'", [], |row| {
                row.get(0)
            })?;
        assert!(staying_body.contains(&asset.id));
        assert!(moved_body.contains(&moved_id));
        Ok::<(), AppError>(())
    })
    .unwrap();
}

#[test]
fn moving_non_owner_across_scope_leaves_original_blob_unchanged() {
    let db = crate::db::open_memory_for_tests();
    db.with_conn(|conn| {
        insert_rehome_note(conn, "owner", None);
        insert_rehome_note(conn, "moving", None);
        let asset = crate::assets::store_deduped(conn, "owner", "image/png", b"shared")?;
        crate::assets::add_ref(conn, &asset.id, "moving")?;
        conn.execute(
            "UPDATE notes SET body = 'asset:mindstream/' || ?1 WHERE id IN ('owner', 'moving')",
            params![asset.id],
        )?;

        rehome_note_subtree(conn, "moving", Some("scope_x"))?;

        let original = asset_row(conn, &asset.id);
        assert_eq!(original.0.as_deref(), Some("owner"));
        assert_eq!(original.1, None);
        assert_eq!(
            original.2, 1,
            "the original asset remains independently syncable"
        );
        assert_eq!(original.3, b"shared");
        let moved_id: String = conn.query_row(
            "SELECT asset_id FROM asset_refs WHERE note_id = 'moving'",
            [],
            |row| row.get(0),
        )?;
        assert_ne!(moved_id, asset.id);
        assert_eq!(asset_row(conn, &moved_id).1.as_deref(), Some("scope_x"));
        Ok::<(), AppError>(())
    })
    .unwrap();
}

#[test]
fn moving_entire_folder_keeps_asset_id_and_unrelated_blobs() {
    let db = crate::db::open_memory_for_tests();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO collections(id, name, position, created, modified, dirty)
             VALUES ('moving_folder', 'Moving', 0, 't', 't', 0)",
            [],
        )?;
        insert_rehome_note(conn, "first", Some("moving_folder"));
        insert_rehome_note(conn, "second", Some("moving_folder"));
        insert_rehome_note(conn, "target_note", None);
        insert_rehome_note(conn, "unrelated_note", None);
        conn.execute(
            "UPDATE notes SET share_scope_id = 'scope_x' WHERE id = 'target_note'",
            [],
        )?;
        let original = crate::assets::store_deduped(conn, "first", "image/png", b"shared")?;
        crate::assets::add_ref(conn, &original.id, "second")?;
        let duplicate = crate::assets::store_deduped(conn, "target_note", "image/png", b"shared")?;
        let unrelated =
            crate::assets::store_deduped(conn, "unrelated_note", "image/png", b"other")?;

        rehome_folder_subtree(conn, "moving_folder", Some("scope_x"))?;

        for note_id in ["first", "second"] {
            let referenced: String = conn.query_row(
                "SELECT asset_id FROM asset_refs WHERE note_id = ?1",
                params![note_id],
                |row| row.get(0),
            )?;
            assert_eq!(
                referenced, original.id,
                "a wholly moving reference set keeps its id"
            );
        }
        assert_eq!(asset_row(conn, &original.id).1.as_deref(), Some("scope_x"));
        assert_eq!(asset_row(conn, &duplicate.id).3, b"shared");
        assert_eq!(asset_row(conn, &unrelated.id).3, b"other");
        Ok::<(), AppError>(())
    })
    .unwrap();
}

#[test]
fn scope_split_preserves_history_and_normalizes_late_saves_after_creator_purge() {
    let db = crate::db::open_memory_for_tests();
    db.with_conn(|conn| {
        insert_rehome_note(conn, "creator", None);
        insert_rehome_note(conn, "moving", None);
        let original = crate::assets::store_deduped(conn, "creator", "image/png", b"shared")?;
        crate::assets::add_ref(conn, &original.id, "moving")?;
        let body = format!("![image](asset:mindstream/{})", original.id);
        let state = crate::sync::yrs_doc::init_with_markdown(&body);
        crate::history::capture(conn, "moving", "markdown", "edited", None, &body)?;
        conn.execute(
            "UPDATE notes SET body = ?1, yrs_state = ?2 WHERE id IN ('creator', 'moving')",
            params![body, state],
        )?;
        rehome_note_subtree(conn, "moving", Some("scope_x"))?;
        let moved_id: String = conn.query_row(
            "SELECT asset_id FROM asset_refs WHERE note_id = 'moving'",
            [],
            |r| r.get(0),
        )?;
        assert_ne!(moved_id, original.id);
        let history: Vec<u8> = conn.query_row(
            "SELECT body FROM note_versions WHERE note_id = 'moving'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(
            crate::history::decompress_snapshot(&history)?,
            body.replace(&original.id, &moved_id)
        );
        crate::assets::release_note_assets(conn, "creator")?;
        conn.execute("DELETE FROM notes WHERE id = 'creator'", [])?;
        assert!(crate::assets::load(conn, &original.id).is_err());
        let (normalized_body, normalized_state) =
            crate::assets::normalize_asset_ids_for_note(conn, "moving", &body, Some(&state))?;
        assert_eq!(normalized_body, body.replace(&original.id, &moved_id));
        assert_eq!(
            crate::sync::yrs_doc::to_markdown(&normalized_state.unwrap()),
            normalized_body
        );
        rehome_note_subtree(conn, "moving", None)?;
        let (again, _) = crate::assets::normalize_asset_ids_for_note(conn, "moving", &body, None)?;
        assert_eq!(again, normalized_body);
        assert_eq!(asset_row(conn, &moved_id).1, None);
        Ok::<(), AppError>(())
    })
    .unwrap();
}

#[test]
fn profile_lookup_error_is_friendly_for_missing_user() {
    let missing = etebase::error::Error::NotFound("User not found.".into());
    let AppError::InvalidArg(message) = profile_lookup_error("bob", &missing) else {
        panic!("expected InvalidArg");
    };
    assert!(message.contains("bob"), "{message}");
    assert!(message.contains("Check the spelling"), "{message}");
    assert!(
        !message.contains("User not found"),
        "the server's wording should not leak: {message}"
    );

    // Anything else keeps its detail, which is what there is to go on.
    let unreachable = etebase::error::Error::Connection("network unreachable".into());
    let AppError::InvalidArg(message) = profile_lookup_error("bob", &unreachable) else {
        panic!("expected InvalidArg");
    };
    assert!(message.contains("network unreachable"), "{message}");
}

/// Purging a folder is decided on "the server says it is not there". An
/// outage or a session that ended must never read as that.
#[test]
fn only_a_definite_no_from_the_server_counts_as_gone() {
    use etebase::error::Error;

    assert!(fetch_says_gone(&Error::NotFound("gone".into())));
    assert!(fetch_says_gone(&Error::PermissionDenied("removed".into())));
    for outage in [
        Error::Connection("timed out".into()),
        Error::TemporaryServerError("503".into()),
        Error::ServerError("500".into()),
        Error::Unauthorized("session ended".into()),
        Error::Http("418".into()),
        Error::Generic("?".into()),
    ] {
        assert!(!fetch_says_gone(&outage), "{outage:?}");
    }
}

#[test]
fn share_manifest_names_the_root_and_carries_fresh_key_material() {
    let manifest = build_share_manifest("coll_root", Some("alice"));

    assert_eq!(manifest.schema, SHARE_MANIFEST_SCHEMA);
    assert_eq!(manifest.root_folder_id, "coll_root");
    assert_eq!(manifest.owner_username.as_deref(), Some("alice"));
    assert_eq!(manifest.collab_epoch, 1);
    assert_eq!(manifest.collab_salt.len(), SHARE_COLLAB_SALT_BYTES);
    // Two folders never share a salt.
    assert_ne!(
        manifest.collab_salt,
        build_share_manifest("coll_root", Some("alice")).collab_salt
    );

    // It goes through the same JSON every member's device reads.
    let json = serde_json::to_vec(&manifest).unwrap();
    let decoded: ShareManifest = serde_json::from_slice(&json).unwrap();
    assert_eq!(decoded, manifest);
}

#[test]
fn share_manifest_reads_without_the_fields_that_have_defaults() {
    let decoded: ShareManifest =
        serde_json::from_str(r#"{"schema":3,"root_folder_id":"coll_root"}"#).unwrap();

    assert_eq!(decoded.owner_username, None);
    assert_eq!(decoded.collab_epoch, 1);
    assert!(decoded.collab_salt.is_empty());
}

#[test]
fn rotate_manifest_collab_secret_increments_epoch_and_replaces_salt() {
    let mut manifest = build_share_manifest("root", Some("alice"));
    let previous_epoch = manifest.collab_epoch;
    let previous_salt = manifest.collab_salt.clone();

    rotate_manifest_collab_secret(&mut manifest);

    assert_eq!(manifest.schema, SHARE_MANIFEST_SCHEMA);
    assert_eq!(manifest.collab_epoch, previous_epoch + 1);
    assert_eq!(manifest.collab_salt.len(), SHARE_COLLAB_SALT_BYTES);
    assert_ne!(manifest.collab_salt, previous_salt);
}

fn insert_folder(conn: &rusqlite::Connection, id: &str, parent: Option<&str>, scope: Option<&str>) {
    conn.execute(
        "INSERT INTO collections(id, parent_collection_id, name, position, created, modified, share_scope_id, dirty)
         VALUES (?1, ?2, ?1, 0, 't', 't', ?3, 0)",
        params![id, parent, scope],
    )
    .unwrap();
}

fn insert_note(conn: &rusqlite::Connection, id: &str, folder: &str, scope: Option<&str>) {
    conn.execute(
        "INSERT INTO notes(id, parent_collection_id, title, body, position, created, modified, share_scope_id, dirty)
         VALUES (?1, ?2, ?1, '', 0, 't', 't', ?3, 0)",
        params![id, folder, scope],
    )
    .unwrap();
}

#[test]
fn sharing_a_folder_marks_its_root_as_shared_by_its_admin() {
    let db = crate::db::open_memory_for_tests();
    db.with_conn(|conn| {
        insert_folder(conn, "root", None, None);
        record_outgoing_share(conn, "root", "col_shared", Some("alice"))?;

        let (scope, share_id, role, owner, by_me): (String, String, String, String, i64) = conn
            .query_row(
                "SELECT share_scope_id, share_id, shared_role, shared_owner, shared_by_me
                   FROM collections WHERE id = 'root'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )?;
        // The collection's uid is both the scope of the rows and the anchor.
        assert_eq!(scope, "col_shared");
        assert_eq!(share_id, "col_shared");
        assert_eq!(role, "admin");
        assert_eq!(owner, "alice");
        assert_eq!(by_me, 1);
        assert!(is_share_anchor(conn, "root")?);
        Ok::<(), AppError>(())
    })
    .unwrap();
}

/// Inviting a second person to a folder must not move the folder again:
/// moving deletes and recreates every item for everyone already in it.
#[test]
fn folder_that_is_wholly_in_its_scope_has_nothing_to_move() {
    let db = crate::db::open_memory_for_tests();
    db.with_conn(|conn| {
        insert_folder(conn, "root", None, Some("col_shared"));
        insert_folder(conn, "child", Some("root"), Some("col_shared"));
        insert_note(conn, "n1", "child", Some("col_shared"));
        // Something elsewhere in the tree does not count.
        insert_folder(conn, "elsewhere", None, None);
        insert_note(conn, "n_elsewhere", "elsewhere", None);
        assert!(!subtree_outside_scope(conn, "root", "col_shared")?);

        // A folder that has never been shared is outside any scope.
        assert!(subtree_outside_scope(conn, "elsewhere", "col_shared")?);

        // One row under the root that missed the stamp is enough.
        insert_note(conn, "n_stray", "child", None);
        assert!(subtree_outside_scope(conn, "root", "col_shared")?);
        conn.execute("DELETE FROM notes WHERE id = 'n_stray'", [])?;
        insert_folder(conn, "stray", Some("child"), Some("another_share"));
        assert!(subtree_outside_scope(conn, "root", "col_shared")?);
        Ok::<(), AppError>(())
    })
    .unwrap();
}

#[test]
fn purge_local_scope_removes_scoped_rows_and_cursors() {
    let db = crate::db::open_memory_for_tests();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position, created, modified, share_scope_id, dirty)
             VALUES ('c', NULL, 'C', 0, 't', 't', 'scope_x', 0)",
            [],
        )?;
        conn.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position, created, modified, share_scope_id, dirty)
             VALUES ('n', 'c', 'N', '', 0, 't', 't', 'scope_x', 0)",
            [],
        )?;
        conn.execute(
            "INSERT INTO assets(id, owning_note_id, mime_type, bytes, size, created, modified, share_scope_id, dirty)
             VALUES ('a', 'n', 'text/plain', x'00', 1, 't', 't', 'scope_x', 0)",
            [],
        )?;
        conn.execute(
            "INSERT INTO tombstones(kind, etebase_uid, queued_at, share_scope_id) VALUES ('note', 'u', 't', 'scope_x')",
            [],
        )?;
        for kind in [
            scope_stoken_key("scope_x"),
            scope_collab_epoch_key("scope_x"),
            crate::sync::held_key(&scope_stoken_key("scope_x")),
        ] {
            conn.execute(
                "INSERT INTO sync_state(kind, stoken) VALUES (?1, 's')",
                params![kind],
            )?;
        }
        // Another folder's cursor stays.
        conn.execute(
            "INSERT INTO sync_state(kind, stoken) VALUES (?1, 's')",
            params![scope_stoken_key("scope_y")],
        )?;
        Ok::<(), AppError>(())
    })
    .unwrap();

    purge_local_scope(&db, "scope_x").unwrap();

    db.with_conn(|conn| {
        let remaining: i64 = conn.query_row(
            "SELECT
                (SELECT COUNT(*) FROM collections WHERE share_scope_id = 'scope_x') +
                (SELECT COUNT(*) FROM notes WHERE share_scope_id = 'scope_x') +
                (SELECT COUNT(*) FROM assets WHERE share_scope_id = 'scope_x') +
                (SELECT COUNT(*) FROM tombstones WHERE share_scope_id = 'scope_x') +
                (SELECT COUNT(*) FROM sync_state WHERE kind LIKE '%:scope_x')",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(remaining, 0);
        let others: i64 = conn.query_row("SELECT COUNT(*) FROM sync_state", [], |r| r.get(0))?;
        assert_eq!(others, 1);
        Ok::<(), AppError>(())
    })
    .unwrap();
}

#[test]
fn purge_local_subtree_removes_root_and_descendants_even_without_scope() {
    // The reconciliation path for a broken / NULL-scope share: removal must
    // work off the collection id alone.
    let db = crate::db::open_memory_for_tests();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position, created, modified, share_id, shared_role, dirty)
             VALUES ('root', NULL, 'Shared', 0, 't', 't', 'folders_uid', 'read_write', 0)",
            [],
        )?;
        conn.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position, created, modified, dirty)
             VALUES ('child', 'root', 'Child', 0, 't', 't', 0)",
            [],
        )?;
        conn.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position, created, modified, etebase_uid, dirty)
             VALUES ('n1', 'child', 'N1', '', 0, 't', 't', 'note_uid', 0)",
            [],
        )?;
        conn.execute(
            "INSERT INTO assets(id, owning_note_id, mime_type, bytes, size, created, modified, dirty)
             VALUES ('a1', 'n1', 'image/png', x'00', 1, 't', 't', 0)",
            [],
        )?;
        // A stale tombstone keyed on the note's uid must be cleared too.
        conn.execute(
            "INSERT INTO tombstones(kind, etebase_uid, queued_at) VALUES ('note', 'note_uid', 't')",
            [],
        )?;
        // An unrelated personal folder must survive.
        conn.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position, created, modified, dirty)
             VALUES ('keep', NULL, 'Keep', 1, 't', 't', 0)",
            [],
        )?;
        Ok::<(), AppError>(())
    })
    .unwrap();

    purge_local_subtree(&db, "root").unwrap();

    db.with_conn(|conn| {
        let gone: i64 = conn.query_row(
            "SELECT
                (SELECT COUNT(*) FROM collections WHERE id IN ('root', 'child')) +
                (SELECT COUNT(*) FROM notes WHERE id = 'n1') +
                (SELECT COUNT(*) FROM assets WHERE id = 'a1') +
                (SELECT COUNT(*) FROM tombstones WHERE etebase_uid = 'note_uid')",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(gone, 0, "subtree rows + tombstone must be purged");
        let kept: i64 = conn.query_row(
            "SELECT COUNT(*) FROM collections WHERE id = 'keep'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(kept, 1, "unrelated personal folder must survive");
        Ok::<(), AppError>(())
    })
    .unwrap();
}

#[test]
fn detach_owner_share_rehomes_to_vault_and_clears_share_metadata() {
    // Stop-sharing's local half: an owner's shared_by_me root + subtree must
    // come back to the vault (share_scope_id NULL, dirty, tombstoned) with the
    // anchor's share columns cleared.
    let db = crate::db::open_memory_for_tests();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position, created, modified, etebase_uid, share_scope_id, share_id, shared_role, shared_owner, shared_by_me, dirty)
             VALUES ('root', NULL, 'Shared', 0, 't', 't', 'scope_root_uid', 'scope_1', 'folders_uid', 'read_write', 'alice', 1, 0)",
            [],
        )?;
        conn.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position, created, modified, etebase_uid, share_scope_id, dirty)
             VALUES ('n1', 'root', 'N1', '', 0, 't', 't', 'scope_n1_uid', 'scope_1', 0)",
            [],
        )?;
        Ok::<(), AppError>(())
    })
    .unwrap();

    db.with_conn(|conn| detach_owner_share(conn, "root"))
        .unwrap();

    db.with_conn(|conn| {
        let (scope, share_id, role, owner, by_me): (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            i64,
        ) = conn.query_row(
            "SELECT share_scope_id, share_id, shared_role, shared_owner, shared_by_me
               FROM collections WHERE id = 'root'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;
        assert!(scope.is_none(), "root scope cleared");
        assert!(share_id.is_none(), "share_id cleared");
        assert!(role.is_none(), "shared_role cleared");
        assert!(owner.is_none(), "shared_owner cleared");
        assert_eq!(by_me, 0, "shared_by_me cleared");

        // Subtree note is back on the vault and marked dirty for re-push.
        let (note_scope, note_dirty): (Option<String>, i64) = conn.query_row(
            "SELECT share_scope_id, dirty FROM notes WHERE id = 'n1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        assert!(note_scope.is_none(), "note re-homed to vault");
        assert_eq!(note_dirty, 1, "note dirty for vault push");

        // The already-pushed rows queued a tombstone routed to their source
        // scope so the old scoped items are deleted.
        let tombstoned: i64 = conn.query_row(
            "SELECT COUNT(*) FROM tombstones WHERE etebase_uid IN ('scope_root_uid', 'scope_n1_uid')",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(tombstoned, 2, "pushed rows tombstoned on detach");
        Ok::<(), AppError>(())
    })
    .unwrap();
}

#[test]
fn detach_owner_share_clears_metadata_on_null_scope_without_rehome() {
    // A broken/dev-era outgoing share: shared_by_me but NULL scope. Stopping it
    // must still clear the share columns (so the folder becomes personal) and
    // must NOT tombstone the already-pushed vault row (no scope to re-home).
    let db = crate::db::open_memory_for_tests();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position, created, modified, etebase_uid, share_id, shared_role, shared_owner, shared_by_me, dirty)
             VALUES ('root', NULL, 'Broken share', 0, 't', 't', 'vault_root', 'folders_uid', 'read_write', 'me', 1, 0)",
            [],
        )?;
        Ok::<(), AppError>(())
    })
    .unwrap();

    db.with_conn(|conn| detach_owner_share(conn, "root"))
        .unwrap();

    db.with_conn(|conn| {
        let (share_id, by_me): (Option<String>, i64) = conn.query_row(
            "SELECT share_id, shared_by_me FROM collections WHERE id = 'root'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        assert!(share_id.is_none(), "share_id cleared");
        assert_eq!(by_me, 0, "shared_by_me cleared");
        let tombstones: i64 =
            conn.query_row("SELECT COUNT(*) FROM tombstones", [], |r| r.get(0))?;
        assert_eq!(tombstones, 0, "no re-home churn on a NULL-scope share");
        Ok::<(), AppError>(())
    })
    .unwrap();
}

#[test]
fn scopes_to_purge_flags_scopes_absent_from_live_set() {
    let local = vec!["a".to_string(), "b".to_string(), "c".to_string()];

    // b was revoked/removed (not in the live manifest set).
    let live: HashSet<String> = ["a", "c"].iter().map(|s| s.to_string()).collect();
    assert_eq!(scopes_to_purge(&local, &live), vec!["b"]);

    // All still live → nothing to purge.
    let all: HashSet<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
    assert!(scopes_to_purge(&local, &all).is_empty());

    // Nothing live (e.g. every share revoked) → purge all.
    assert_eq!(
        scopes_to_purge(&local, &HashSet::new()),
        vec!["a", "b", "c"]
    );
}

fn link_input(access_level: ShareAccessLevel) -> CreateShareLinkInput {
    CreateShareLinkInput {
        collection_id: "folder".into(),
        access_level,
        max_uses: None,
        expires_in_days: None,
        allow_signup: false,
    }
}

/// Whoever holds a link is a stranger until they use it. A stranger is not
/// handed the power to remove everyone else.
#[test]
fn invite_link_lets_people_view_or_edit_and_never_manage() {
    assert!(link_options(&link_input(ShareAccessLevel::ReadOnly)).is_ok());
    assert!(link_options(&link_input(ShareAccessLevel::ReadWrite)).is_ok());
    let AppError::InvalidArg(message) =
        link_options(&link_input(ShareAccessLevel::Admin)).unwrap_err()
    else {
        panic!("expected InvalidArg");
    };
    assert!(message.contains("not manage"), "{message}");
}

#[test]
fn link_is_only_good_on_the_server_that_made_it() {
    for (signed_in_to, link_server) in [
        ("https://notes.example.com", "https://notes.example.com/"),
        ("https://Notes.Example.com/", "https://notes.example.com"),
        (
            "https://notes.example.com:443/",
            "https://notes.example.com/",
        ),
        ("http://localhost:3735", "http://localhost:3735/"),
        ("https://example.com/notes", "https://example.com/notes/"),
    ] {
        assert!(
            same_server(signed_in_to, link_server),
            "{signed_in_to} / {link_server}"
        );
    }
    for (signed_in_to, link_server) in [
        ("https://notes.example.com/", "https://other.example.com/"),
        ("https://notes.example.com/", "http://notes.example.com/"),
        ("http://localhost:3735/", "http://localhost:3736/"),
        ("https://example.com/notes/", "https://example.com/other/"),
        ("https://example.com/", "https://example.com.evil.test/"),
        ("not a url", "https://example.com/"),
        ("", ""),
    ] {
        assert!(
            !same_server(signed_in_to, link_server),
            "{signed_in_to} / {link_server}"
        );
    }
}

#[test]
fn moving_a_folder_into_its_collection_marks_the_root_once() {
    let db = crate::db::open_memory_for_tests();
    db.with_conn(|conn| {
        insert_folder(conn, "root", None, None);
        insert_note(conn, "n1", "root", None);

        move_into_space(conn, "root", "col_shared", true, Some("alice"))?;
        assert!(is_share_anchor(conn, "root")?);
        assert_eq!(note_scope(conn, "n1")?.as_deref(), Some("col_shared"));

        // Once the folder has synced, making a link or inviting someone
        // else must leave its rows attached where they are.
        conn.execute(
            "UPDATE notes SET etebase_uid = 'uid_n1', dirty = 0 WHERE id = 'n1'",
            [],
        )?;
        conn.execute(
            "UPDATE collections SET etebase_uid = 'uid_root', dirty = 0 WHERE id = 'root'",
            [],
        )?;
        move_into_space(conn, "root", "col_shared", false, Some("alice"))?;
        let uid: Option<String> =
            conn.query_row("SELECT etebase_uid FROM notes WHERE id = 'n1'", [], |r| {
                r.get(0)
            })?;
        assert_eq!(uid.as_deref(), Some("uid_n1"));
        let queued: i64 = conn.query_row("SELECT COUNT(*) FROM tombstones", [], |r| r.get(0))?;
        assert_eq!(queued, 0);
        Ok::<(), AppError>(())
    })
    .unwrap();
}
