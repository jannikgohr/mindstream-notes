use super::*;
use crate::db::open_memory_for_tests;

fn manifest(root_folder_id: &str, owner: Option<&str>) -> ShareManifest {
    ShareManifest {
        schema: crate::sharing::SHARE_MANIFEST_SCHEMA,
        share_scope_id: "scope_1".into(),
        name: "Shared".into(),
        root_folder_id: root_folder_id.into(),
        owner_username: owner.map(str::to_string),
        collab_epoch: 1,
        collab_salt: vec![7; crate::sharing::SHARE_COLLAB_SALT_BYTES],
        collections: Vec::new(),
    }
}

fn part_ref(part: ShareScopePart, uid: &str) -> crate::sharing::ShareManifestCollectionRef {
    crate::sharing::ShareManifestCollectionRef {
        part,
        collection_uid: uid.into(),
        required: true,
    }
}

#[test]
fn part_uid_resolves_each_part_and_reports_missing() {
    let mut m = manifest("folder_root", Some("alice"));
    m.collections = vec![
        part_ref(ShareScopePart::Folders, "folders_col"),
        part_ref(ShareScopePart::Notes, "notes_col"),
    ];

    assert_eq!(part_uid(&m, ShareScopePart::Folders), Some("folders_col"));
    assert_eq!(part_uid(&m, ShareScopePart::Notes), Some("notes_col"));
    // The assets part isn't listed, so it resolves to None — this is the
    // exact condition sync_one_scope uses to skip an incomplete scope.
    assert_eq!(part_uid(&m, ShareScopePart::Assets), None);
}

#[test]
fn part_uid_returns_first_match_for_duplicate_parts() {
    let mut m = manifest("folder_root", None);
    m.collections = vec![
        part_ref(ShareScopePart::Folders, "first"),
        part_ref(ShareScopePart::Folders, "second"),
    ];
    assert_eq!(part_uid(&m, ShareScopePart::Folders), Some("first"));
}

#[test]
fn record_scope_collab_epoch_marks_scope_notes_when_epoch_first_seen_or_changed() {
    let db = open_memory_for_tests();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO notes(id, title, body, position, created, modified, share_scope_id)
             VALUES ('note_b', 'B', '', 0, 't', 't', 'scope_1')",
            [],
        )?;
        conn.execute(
            "INSERT INTO notes(id, title, body, position, created, modified, share_scope_id)
             VALUES ('note_a', 'A', '', 0, 't', 't', 'scope_1')",
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

    let mut m = manifest("folder_root", Some("alice"));
    let mut delta = SyncDelta::default();
    record_scope_collab_epoch(&db, &m, &mut delta).unwrap();
    assert_eq!(
        delta.collab_credentials_changed_note_ids,
        vec!["note_a", "note_b"]
    );

    delta.collab_credentials_changed_note_ids.clear();
    record_scope_collab_epoch(&db, &m, &mut delta).unwrap();
    assert!(delta.collab_credentials_changed_note_ids.is_empty());

    m.collab_epoch += 1;
    record_scope_collab_epoch(&db, &m, &mut delta).unwrap();
    assert_eq!(
        delta.collab_credentials_changed_note_ids,
        vec!["note_a", "note_b"]
    );
}

#[test]
fn record_scope_collab_epoch_ignores_legacy_manifest_without_salt() {
    let db = open_memory_for_tests();
    let mut m = manifest("folder_root", Some("alice"));
    m.collab_salt.clear();
    let mut delta = SyncDelta::default();

    record_scope_collab_epoch(&db, &m, &mut delta).unwrap();

    assert!(delta.collab_credentials_changed_note_ids.is_empty());
    assert_eq!(
        load_scope_collab_epoch(&db, &m.share_scope_id).unwrap(),
        None
    );
}

#[test]
fn discard_read_only_scope_edits_removes_local_rows_and_rewinds_stokens() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        for kind in [
            "scope-folders:scope_1",
            "scope-notes:scope_1",
            "scope-assets:scope_1",
        ] {
            c.execute(
                "INSERT INTO sync_state(kind, stoken) VALUES (?1, 'old-stoken')",
                params![kind],
            )?;
        }
        c.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position,
                                     created, modified, dirty, etebase_uid,
                                     share_scope_id)
             VALUES ('remote_folder', NULL, 'Local rename', 0, 't', 't', 1,
                     'uid_folder', 'scope_1')",
            [],
        )?;
        c.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position,
                                     created, modified, dirty, share_scope_id)
             VALUES ('local_folder', NULL, 'Bad local folder', 1, 't', 't', 1,
                     'scope_1')",
            [],
        )?;
        c.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position,
                               created, modified, trashed_at, yrs_state,
                               etebase_uid, etebase_etag, dirty, payload_schema,
                               favourite, note_kind, tags_state, share_scope_id)
             VALUES ('remote_note', NULL, 'Local title', 'local body', 0,
                     't', 't', NULL, x'0102', 'uid_note', 'etag_note', 1, 2,
                     1, 'markdown', x'0304', 'scope_1')",
            [],
        )?;
        c.execute(
            "INSERT INTO note_tags(note_id, tag) VALUES ('remote_note', 'local')",
            [],
        )?;
        c.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position,
                               created, modified, dirty, payload_schema,
                               favourite, note_kind, share_scope_id)
             VALUES ('local_note', NULL, 'Bad local note', '', 1, 't', 't',
                     1, 2, 0, 'markdown', 'scope_1')",
            [],
        )?;
        c.execute(
            "INSERT INTO assets(id, owning_note_id, mime_type, bytes, size,
                                created, modified, dirty, etebase_uid,
                                share_scope_id)
             VALUES ('remote_asset', 'remote_note', 'text/plain', x'01', 1,
                     't', 't', 1, 'uid_asset', 'scope_1')",
            [],
        )?;
        c.execute(
            "INSERT INTO assets(id, owning_note_id, mime_type, bytes, size,
                                created, modified, dirty, share_scope_id)
             VALUES ('local_asset', 'local_note', 'text/plain', x'02', 1,
                     't', 't', 1, 'scope_1')",
            [],
        )?;
        for (kind, uid) in [
            ("folder", "uid_folder_delete"),
            ("note", "uid_note_delete"),
            ("asset", "uid_asset_delete"),
        ] {
            c.execute(
                "INSERT INTO tombstones(kind, etebase_uid, queued_at, share_scope_id)
                 VALUES (?1, ?2, 't', 'scope_1')",
                params![kind, uid],
            )?;
        }
        Ok(())
    })
    .unwrap();

    let repair = discard_read_only_scope_edits(&db, "scope_1").unwrap();
    reset_scope_stokens(&db, "scope_1").unwrap();

    assert_eq!(repair.folders_discarded, 1);
    assert_eq!(repair.folders_reset, 1);
    assert_eq!(repair.notes_discarded, 1);
    assert_eq!(repair.notes_reset, 1);
    assert_eq!(repair.assets_discarded, 1);
    assert_eq!(repair.assets_reset, 1);
    assert_eq!(repair.tombstones_discarded, 3);
    assert_eq!(repair.total(), 9);

    let (remote_folder_dirty, remote_note_dirty, remote_asset_dirty): (i64, i64, i64) = db
        .with_conn(|c| {
            Ok((
                c.query_row(
                    "SELECT dirty FROM collections WHERE id = 'remote_folder'",
                    [],
                    |r| r.get(0),
                )?,
                c.query_row(
                    "SELECT dirty FROM notes WHERE id = 'remote_note'",
                    [],
                    |r| r.get(0),
                )?,
                c.query_row(
                    "SELECT dirty FROM assets WHERE id = 'remote_asset'",
                    [],
                    |r| r.get(0),
                )?,
            ))
        })
        .unwrap();
    assert_eq!(remote_folder_dirty, 0);
    assert_eq!(remote_note_dirty, 0);
    assert_eq!(remote_asset_dirty, 0);

    let (yrs_state, tags_state): (Option<Vec<u8>>, Option<Vec<u8>>) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT yrs_state, tags_state FROM notes WHERE id = 'remote_note'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert!(yrs_state.is_none());
    assert!(tags_state.is_none());

    let local_count: i64 = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT
                    (SELECT COUNT(*) FROM collections WHERE id = 'local_folder') +
                    (SELECT COUNT(*) FROM notes WHERE id = 'local_note') +
                    (SELECT COUNT(*) FROM assets WHERE id = 'local_asset') +
                    (SELECT COUNT(*) FROM tombstones WHERE share_scope_id = 'scope_1')",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(local_count, 0);
    assert_eq!(
        load_stoken(&db, &scope_folders_stoken_key("scope_1")).unwrap(),
        None
    );
    assert_eq!(
        load_stoken(&db, &scope_notes_stoken_key("scope_1")).unwrap(),
        None
    );
    assert_eq!(
        load_stoken(&db, &scope_assets_stoken_key("scope_1")).unwrap(),
        None
    );
}

#[test]
fn project_shared_root_marks_recipient_root_as_shared() {
    // A folder pulled from the scope carries only placement metadata; the
    // projection stamps the manifest's share membership so it lands in
    // "shared with me" rather than Home.
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position,
                                     created, modified, dirty, share_scope_id)
             VALUES ('folder_root', NULL, 'Shared', 0, 't', 't', 0, 'scope_1')",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    // Syncing account ("bob") is not the scope owner ("alice") → recipient.
    project_shared_root(
        &db,
        &manifest("folder_root", Some("alice")),
        CollectionAccessLevel::ReadOnly,
        "folders_uid",
        Some("bob"),
    )
    .unwrap();

    let (owner, role, share_id, by_me): (Option<String>, Option<String>, Option<String>, i64) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT shared_owner, shared_role, share_id, shared_by_me
                   FROM collections WHERE id = 'folder_root'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?)
        })
        .unwrap();
    assert_eq!(owner.as_deref(), Some("alice"));
    assert_eq!(role.as_deref(), Some("read_only"));
    assert_eq!(share_id.as_deref(), Some("folders_uid"));
    assert_eq!(by_me, 0);
}

#[test]
fn project_shared_root_leaves_owner_row_untouched() {
    // The owner runs scope sync on their own scope too. Their root already
    // carries the authoritative shared_by_me=1 stamp and must not be
    // downgraded to a shared-with-me projection.
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position,
                                     created, modified, dirty, share_scope_id,
                                     shared_by_me, shared_role, shared_owner)
             VALUES ('folder_root', NULL, 'Shared', 0, 't', 't', 0, 'scope_1',
                     1, 'admin', 'alice')",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    // Recipient device ("bob" ≠ owner) whose row already carries the
    // authoritative shared_by_me = 1 — the guard must leave it untouched.
    project_shared_root(
        &db,
        &manifest("folder_root", Some("carol")),
        CollectionAccessLevel::ReadOnly,
        "folders_uid",
        Some("bob"),
    )
    .unwrap();

    let (owner, role, by_me): (Option<String>, Option<String>, i64) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT shared_owner, shared_role, shared_by_me
                   FROM collections WHERE id = 'folder_root'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?)
        })
        .unwrap();
    assert_eq!(by_me, 1, "owner's shared_by_me stamp is preserved");
    assert_eq!(owner.as_deref(), Some("alice"), "owner metadata untouched");
    assert_eq!(role.as_deref(), Some("admin"));
}

#[test]
fn project_shared_root_stamps_owner_second_device() {
    // The owner shares from device A1 (which stamps shared_by_me = 1) and
    // syncs the same scope on device A2, which pulls the root with
    // shared_by_me = 0. Because the syncing account matches the manifest
    // owner, A2 must also be stamped shared_by_me = 1 so the folder stays in
    // Home with the shared-by-me badge instead of falling under
    // "shared with me".
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position,
                                     created, modified, dirty, share_scope_id)
             VALUES ('folder_root', NULL, 'Shared', 0, 't', 't', 0, 'scope_1')",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    project_shared_root(
        &db,
        &manifest("folder_root", Some("alice")),
        CollectionAccessLevel::Admin,
        "folders_uid",
        Some("alice"),
    )
    .unwrap();

    let (owner, share_id, by_me): (Option<String>, Option<String>, i64) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT shared_owner, share_id, shared_by_me
                   FROM collections WHERE id = 'folder_root'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?)
        })
        .unwrap();
    assert_eq!(by_me, 1, "owner's other device is stamped shared_by_me");
    assert_eq!(owner.as_deref(), Some("alice"));
    assert_eq!(share_id.as_deref(), Some("folders_uid"));
}
