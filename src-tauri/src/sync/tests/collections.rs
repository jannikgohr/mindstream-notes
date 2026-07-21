//! Collection selection, stoken errors and reconcile migration.

use super::fixtures::*;
use super::*;

#[test]
fn is_bad_stoken_error_matches_etebase_sdk_message() {
    // The exact wording the etebase-rs SDK surfaces when the
    // server returns 400 Bad Request with code='bad_stoken'.
    // Reproduced from a real failure when signing back in to a
    // different etebase server with stale local cursors.
    let folders = AppError::InvalidArg(
        "list folders: HTTP error 400! Code: 'bad_stoken'. Detail: 'Invalid stoken.'".into(),
    );
    let notes = AppError::InvalidArg(
        "list notes: HTTP error 400! Code: 'bad_stoken'. Detail: 'Invalid stoken.'".into(),
    );
    let assets = AppError::InvalidArg(
        "list assets: HTTP error 400! Code: 'bad_stoken'. Detail: 'Invalid stoken.'".into(),
    );
    assert!(is_bad_stoken_error(&folders));
    assert!(is_bad_stoken_error(&notes));
    assert!(is_bad_stoken_error(&assets));
}

#[test]
fn is_bad_stoken_error_rejects_unrelated_errors() {
    // Adjacent etebase errors must NOT trigger the retry — silently
    // resetting cursors on, say, a transient 401 would mask the
    // real failure and cost the user a full re-sync.
    let unauthorized = AppError::InvalidArg(
        "list folders: HTTP error 401! Code: 'unauthorized'. Detail: 'Bad token.'".into(),
    );
    let not_found = AppError::InvalidArg(
        "list notes: HTTP error 404! Code: 'not_found'. Detail: 'Collection not found.'".into(),
    );
    let bare = AppError::InvalidArg("list folders: connection refused".into());
    // Substring without the quotes (someone misspelling in a log
    // message) should not trip either.
    let prose = AppError::InvalidArg(
        "list folders: HTTP error 500! the server replied with bad stoken handling".into(),
    );
    assert!(!is_bad_stoken_error(&unauthorized));
    assert!(!is_bad_stoken_error(&not_found));
    assert!(!is_bad_stoken_error(&bare));
    assert!(!is_bad_stoken_error(&prose));
}

#[test]
fn usable_vault_collection_rejects_read_only_and_scope_parts() {
    let mut scope_parts = HashSet::new();
    scope_parts.insert("scope_folders".to_string());

    let read_only = VaultCollectionCandidate {
        uid: "external_read_only",
        is_deleted: false,
        access_level: CollectionAccessLevel::ReadOnly,
    };
    let scope_part = VaultCollectionCandidate {
        uid: "scope_folders",
        is_deleted: false,
        access_level: CollectionAccessLevel::ReadWrite,
    };
    let vault = VaultCollectionCandidate {
        uid: "vault_folders",
        is_deleted: false,
        access_level: CollectionAccessLevel::Admin,
    };

    assert!(!usable_vault_collection(&read_only, &scope_parts));
    assert!(!usable_vault_collection(&scope_part, &scope_parts));
    assert!(usable_vault_collection(&vault, &scope_parts));
}

#[test]
fn rehome_detaches_then_scope_pull_reclaims_with_local_edits() {
    // The A/B offline-merge scenario: device A has an unpushed edit to a
    // note in a folder that device B just shared. B's re-home tombstones
    // the vault copy and recreates it in the scope. A must detach (not
    // delete) on the tombstone, then reclaim the same row by stable `id`
    // when the scope copy arrives — keeping A's edit and stamping the scope
    // (which makes the vault push skip it, so no orphan copy is created).
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position,
                                     created, modified, dirty)
             VALUES ('folder_f', NULL, 'F', 0, 't', 't', 0)",
            [],
        )?;
        c.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position,
                               created, modified, trashed_at, yrs_state,
                               etebase_uid, etebase_etag, dirty, payload_schema,
                               favourite, note_kind)
             VALUES ('note_n', 'folder_f', 'A offline title', '', 0, 't', 't', NULL,
                     NULL, 'uid_vault', 'etag_old', 1, 2, 0, 'markdown')",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    // 1. Vault tombstone from B's re-home: detach, don't delete.
    db.with_conn(|c| apply_remote_delete(c, "notes", "uid_vault"))
        .unwrap();
    let survived: i64 = db
        .with_conn(|c| {
            Ok(
                c.query_row("SELECT COUNT(*) FROM notes WHERE id = 'note_n'", [], |r| {
                    r.get(0)
                })?,
            )
        })
        .unwrap();
    assert_eq!(survived, 1, "A's dirty note survives the re-home tombstone");

    // 2. Scope copy of the same note arrives (B's content, new uid, scope).
    let remote = remote_note("note_n", Some("folder_f"), None);
    apply_note_payload(
        &db,
        &remote,
        "uid_scope",
        "etag_scope",
        Some("scope_1"),
        true,
    )
    .unwrap();

    let (scope, uid, dirty, title): (Option<String>, Option<String>, i64, String) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT share_scope_id, etebase_uid, dirty, title
                 FROM notes WHERE id = 'note_n'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?)
        })
        .unwrap();
    assert_eq!(
        scope.as_deref(),
        Some("scope_1"),
        "the note is re-homed into the scope"
    );
    assert_eq!(
        uid.as_deref(),
        Some("uid_scope"),
        "the note now carries the scope uid"
    );
    assert_eq!(
        dirty, 1,
        "A's unpushed edit stays dirty to push into the scope"
    );
    assert_eq!(
        title, "A offline title",
        "A's offline edit is preserved over B's copy"
    );
}

#[test]
fn switch_to_collection_rehomes_vault_rows_only() {
    // The reconcile "loser" migrates onto the winner: its vault rows get
    // dirtied with their old collection-scoped item uid/etag cleared (so
    // push re-creates them in the winner), while scoped rows and the
    // local-only 'trash' folder are left untouched. The cache repoints and
    // the pull cursor resets.
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        // Pre-existing cache pointing at the loser collection with a stoken.
        c.execute(
            "INSERT INTO sync_state (kind, etebase_collection_uid, stoken, reconcile_passes_left)
             VALUES ('notes', 'loser_uid', 'stok_old', 1)",
            [],
        )?;
        // Vault note synced to the loser collection.
        c.execute(
            "INSERT INTO notes(id, title, body, position, created, modified,
                               etebase_uid, etebase_etag, dirty, note_kind)
             VALUES ('note_vault', 'V', '', 0, 't', 't', 'item_v', 'etag_v', 0, 'markdown')",
            [],
        )?;
        // Scoped (shared) note — must keep its own routing.
        c.execute(
            "INSERT INTO notes(id, title, body, position, created, modified,
                               etebase_uid, etebase_etag, dirty, note_kind, share_scope_id)
             VALUES ('note_scoped', 'S', '', 0, 't', 't', 'item_s', 'etag_s', 0, 'markdown', 'scope_1')",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    switch_to_collection(&db, KIND_NOTES, "winner_uid").unwrap();

    let (uid, stoken, passes): (Option<String>, Option<String>, i64) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT etebase_collection_uid, stoken, reconcile_passes_left
                 FROM sync_state WHERE kind = 'notes'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?)
        })
        .unwrap();
    assert_eq!(
        uid.as_deref(),
        Some("winner_uid"),
        "cache repoints to winner"
    );
    assert_eq!(stoken, None, "stale pull cursor is cleared");
    assert_eq!(passes, RECONCILE_PASSES, "window re-arms on migrate");

    let (v_uid, v_etag, v_dirty): (Option<String>, Option<String>, i64) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT etebase_uid, etebase_etag, dirty FROM notes WHERE id = 'note_vault'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?)
        })
        .unwrap();
    assert_eq!(v_uid, None, "vault row's loser item uid is cleared");
    assert_eq!(v_etag, None, "vault row's loser etag is cleared");
    assert_eq!(
        v_dirty, 1,
        "vault row is dirtied to re-create in the winner"
    );

    let (s_uid, s_dirty): (Option<String>, i64) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT etebase_uid, dirty FROM notes WHERE id = 'note_scoped'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(
        s_uid.as_deref(),
        Some("item_s"),
        "scoped row keeps its routing"
    );
    assert_eq!(s_dirty, 0, "scoped row is not touched by a vault reconcile");
}

#[test]
fn switch_to_collection_leaves_trash_folder_local() {
    // The built-in 'trash' folder is a local construct (dirty=0, never
    // pushed). A folders reconcile must not dirty it or clear anything.
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO sync_state (kind, etebase_collection_uid, stoken, reconcile_passes_left)
             VALUES ('folders', 'loser_uid', NULL, 1)",
            [],
        )?;
        c.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position,
                                     created, modified, etebase_uid, etebase_etag, dirty)
             VALUES ('coll_real', NULL, 'Real', 0, 't', 't', 'item_r', 'etag_r', 0)",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    switch_to_collection(&db, KIND_FOLDERS, "winner_uid").unwrap();

    let trash_dirty: i64 = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT dirty FROM collections WHERE id = 'trash'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(trash_dirty, 0, "trash stays local-only, never re-homed");

    let real_dirty: i64 = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT dirty FROM collections WHERE id = 'coll_real'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(
        real_dirty, 1,
        "a real vault folder is re-homed onto the winner"
    );
}
