use super::collab_room::*;
use super::*;
use crate::db::open_memory_for_tests;
use p256::pkcs8::DecodePrivateKey;

fn remote_note(id: &str, parent: Option<&str>, trashed_at: Option<&str>) -> NotePayload {
    NotePayload {
        schema: 2,
        id: id.into(),
        parent_folder_id: parent.map(str::to_string),
        title: "Remote Title".into(),
        position: 0,
        created: Some("2026-05-01T12:00:00Z".into()),
        modified: Some("2026-05-02T12:00:00Z".into()),
        tags: vec![],
        tags_state: vec![],
        trashed_at: trashed_at.map(str::to_string),
        yrs_state: vec![],
        body: String::new(),
        crypto_key: vec![],
        favourite: false,
        note_kind: "markdown".into(),
    }
}

fn collab_info(epoch: u64, salt: &[u8]) -> ShareScopeCollabInfo {
    ShareScopeCollabInfo {
        notes_collection_uid: "scope_notes".into(),
        assets_collection_uid: "scope_assets".into(),
        collab_epoch: epoch,
        collab_salt: salt.to_vec(),
    }
}

/// The room id must never be the Etebase item UID: the server stores that
/// in plaintext, so naming the room after it hands the operator a join
/// credential for every personal note.
#[test]
fn derive_live_collab_room_never_names_the_room_after_the_item_uid() {
    let note_key = [3_u8; 32];

    let room = derive_live_collab_room("note_uid", &note_key, None).unwrap();

    assert_ne!(room.room_id, "note_uid");
    assert!(valid_collab_writer_public_key(&room.room_id));
    assert_eq!(room.collab_epoch, 0);
    assert!(room.writer_auth.is_none());
    assert!(!room.join_private_key_pkcs8_b64.is_empty());
}

/// Personal rooms used to put the Etebase item key straight on the wire,
/// so one key served both at-rest storage and AES-GCM transport.
#[test]
fn unscoped_rooms_do_not_reuse_the_item_key_on_the_wire() {
    let note_key = [3_u8; 32];

    let room = derive_live_collab_room("note_uid", &note_key, None).unwrap();

    assert_ne!(room.key_b64, etebase::utils::to_base64(&note_key).unwrap());
    // Still deterministic, or a second device couldn't join.
    let again = derive_live_collab_room("note_uid", &note_key, None).unwrap();
    assert_eq!(room.key_b64, again.key_b64);
    // And still bound to the note.
    let other = derive_live_collab_room("other_uid", &note_key, None).unwrap();
    assert_ne!(room.key_b64, other.key_b64);
}

/// The join keypair and the wire key both come off the same HKDF input,
/// so they must be separated by their info strings.
#[test]
fn join_key_and_wire_key_are_domain_separated() {
    let note_key = [3_u8; 32];

    let wire = derive_live_collab_key("note_uid", &note_key, None, 0).unwrap();
    let (_, join_priv) = derive_collab_join_keypair("note_uid", &note_key, None, 0).unwrap();

    let wire_b64 = BASE64_STANDARD.encode(wire);
    assert_ne!(wire_b64, join_priv);
    assert!(!join_priv.contains(&wire_b64));
}

#[test]
fn derive_collab_join_keypair_is_deterministic_and_separated() {
    let note_key = [3_u8; 32];
    let salt = [9_u8; 32];

    let (pub_a, priv_a) = derive_collab_join_keypair("note_uid", &note_key, None, 0).unwrap();
    let (pub_b, priv_b) = derive_collab_join_keypair("note_uid", &note_key, None, 0).unwrap();
    assert_eq!(pub_a, pub_b, "same inputs must yield the same room");
    assert_eq!(priv_a, priv_b);

    // Every input that scopes a room must change the keypair, or a
    // revoked member's derived key would still open the rotated room.
    let other_note = derive_collab_join_keypair("other_uid", &note_key, None, 0).unwrap();
    let other_epoch = derive_collab_join_keypair("note_uid", &note_key, Some(&salt), 1).unwrap();
    let other_salt = derive_collab_join_keypair("note_uid", &note_key, Some(&salt), 0).unwrap();
    assert_ne!(pub_a, other_note.0);
    assert_ne!(pub_a, other_salt.0);
    assert_ne!(other_salt.0, other_epoch.0);
}

/// The public half is the room id, so it has to be exactly the P-256 SPKI
/// shape the relay parses — the same validation writer keys go through.
#[test]
fn derive_collab_join_keypair_emits_p256_spki() {
    let (public_b64, private_b64) =
        derive_collab_join_keypair("note_uid", &[3_u8; 32], None, 0).unwrap();

    assert!(valid_collab_writer_public_key(&public_b64));
    let private_der = BASE64_STANDARD.decode(&private_b64).unwrap();
    assert!(p256::SecretKey::from_pkcs8_der(&private_der).is_ok());
}

#[test]
fn derive_live_collab_room_uses_scope_salt_and_epoch() {
    let note_key = [3_u8; 32];
    let epoch_one = collab_info(1, &[9_u8; 32]);
    let epoch_two = collab_info(2, &[9_u8; 32]);
    let different_salt = collab_info(1, &[8_u8; 32]);

    let scoped = derive_live_collab_room("note_uid", &note_key, Some(&epoch_one)).unwrap();
    let rotated_epoch = derive_live_collab_room("note_uid", &note_key, Some(&epoch_two)).unwrap();
    let rotated_salt =
        derive_live_collab_room("note_uid", &note_key, Some(&different_salt)).unwrap();

    assert_ne!(scoped.room_id, "note_uid");
    assert_ne!(
        scoped.key_b64,
        etebase::utils::to_base64(&note_key).unwrap()
    );
    assert_ne!(
        scoped.join_private_key_pkcs8_b64,
        rotated_epoch.join_private_key_pkcs8_b64
    );
    assert_eq!(scoped.collab_epoch, 1);
    assert!(scoped.writer_auth.is_none());
    assert_ne!(scoped.room_id, rotated_epoch.room_id);
    assert_ne!(scoped.key_b64, rotated_epoch.key_b64);
    assert_ne!(scoped.room_id, rotated_salt.room_id);
    assert_ne!(scoped.key_b64, rotated_salt.key_b64);
}

#[test]
fn live_collab_rooms_are_withheld_from_read_only_shared_members() {
    assert!(!can_receive_live_collab_room(
        CollectionAccessLevel::ReadOnly,
        true
    ));
    assert!(can_receive_live_collab_room(
        CollectionAccessLevel::ReadWrite,
        true
    ));
    assert!(can_receive_live_collab_room(
        CollectionAccessLevel::Admin,
        true
    ));
    assert!(can_receive_live_collab_room(
        CollectionAccessLevel::ReadOnly,
        false
    ));
}

#[test]
fn collab_writer_public_key_validation_requires_p256_spki_b64() {
    let mut der = P256_SPKI_DER_PREFIX.to_vec();
    der.extend(1_u8..=64);
    let key_b64 = BASE64_STANDARD.encode(&der);

    assert!(valid_collab_writer_public_key(&key_b64));
    assert!(!valid_collab_writer_public_key(""));
    assert!(!valid_collab_writer_public_key("not base64"));

    let mut wrong_prefix = der;
    wrong_prefix[0] = 0x31;
    assert!(!valid_collab_writer_public_key(
        &BASE64_STANDARD.encode(wrong_prefix)
    ));
}

#[test]
fn collab_writer_key_payload_round_trips_json() {
    let payload = CollabWriterKeyPayload {
        schema: 1,
        share_scope_id: "scope_1".into(),
        collab_epoch: 7,
        public_key_b64: "public".into(),
        username: Some("alice".into()),
    };

    let encoded = serde_json::to_vec(&payload).unwrap();
    let decoded: CollabWriterKeyPayload = serde_json::from_slice(&encoded).unwrap();

    assert_eq!(decoded, payload);
}

#[test]
fn writable_collab_writer_filter_drops_read_only_usernames() {
    let writers = vec![
        RoomAuthorizedWriter {
            username: "alice".into(),
            public_key_b64: "alice_key".into(),
        },
        RoomAuthorizedWriter {
            username: "bob".into(),
            public_key_b64: "bob_key".into(),
        },
    ];
    let writable_usernames = HashSet::from(["alice".to_string()]);

    assert_eq!(
        filter_writable_collab_writers(writers, &writable_usernames),
        vec![RoomAuthorizedWriter {
            username: "alice".into(),
            public_key_b64: "alice_key".into(),
        }]
    );
}

#[test]
fn apply_note_keeps_local_trash_when_dirty() {
    // Repro for the "notes restore themselves from trash on restart" bug:
    // a note trashed locally but not yet pushed (dirty=1, trashed_at set)
    // must not be reverted by a pull of the older, un-trashed remote copy
    // (which a bad_stoken full re-pull would feed in).
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position,
                                     created, modified, dirty)
             VALUES ('coll_work', NULL, 'Work', 0, 't', 't', 0)",
            [],
        )?;
        c.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position,
                               created, modified, trashed_at, yrs_state,
                               etebase_uid, etebase_etag, dirty, payload_schema,
                               favourite, note_kind)
             VALUES ('note_x', 'coll_work', 'Local Title', '', 0, 't', 't',
                     '2026-06-01T00:00:00Z', NULL, 'uid_x', 'etag_old', 1, 2,
                     0, 'markdown')",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    // Stale remote: not trashed, parent stripped to root.
    let remote = remote_note("note_x", None, None);
    apply_note_payload(&db, &remote, "uid_x", "etag_new", None, true).unwrap();

    let (trashed_at, parent, dirty, title): (Option<String>, Option<String>, i64, String) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT trashed_at, parent_collection_id, dirty, title
                 FROM notes WHERE id = 'note_x'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?)
        })
        .unwrap();
    assert!(
        trashed_at.is_some(),
        "locally-trashed note must stay trashed after a pull"
    );
    assert_eq!(
        parent.as_deref(),
        Some("coll_work"),
        "local parent must be preserved, not reset to root"
    );
    assert_eq!(dirty, 1, "row stays dirty so the trash pushes next sync");
    assert_eq!(
        title, "Local Title",
        "local metadata is preserved wholesale"
    );
    let (created, modified): (String, String) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT created, modified FROM notes WHERE id = 'note_x'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(created, "t", "dirty note must keep local created date");
    assert_eq!(
        modified, "t",
        "dirty note must keep local modified date until pushed"
    );
}

#[test]
fn apply_note_takes_remote_metadata_when_clean() {
    // The flip side: a clean (non-dirty) local row must still accept the
    // remote's metadata, including a remote-side trash.
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position,
                               created, modified, trashed_at, yrs_state,
                               etebase_uid, etebase_etag, dirty, payload_schema,
                               favourite, note_kind)
             VALUES ('note_y', NULL, 'Old', '', 0, 't', 't', NULL, NULL,
                     'uid_y', 'etag_old', 0, 2, 0, 'markdown')",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    let remote = remote_note("note_y", None, Some("2026-06-10T00:00:00Z"));
    apply_note_payload(&db, &remote, "uid_y", "etag_new", None, true).unwrap();

    let (title, trashed_at, created, modified): (String, Option<String>, String, String) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT title, trashed_at, created, modified FROM notes WHERE id = 'note_y'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?)
        })
        .unwrap();
    assert_eq!(
        title, "Remote Title",
        "a clean local row takes remote metadata"
    );
    assert!(
        trashed_at.is_some(),
        "a remote-side trash applies to a clean local row"
    );
    assert_eq!(
        created, "2026-05-01T12:00:00Z",
        "clean row takes remote created date"
    );
    assert_eq!(
        modified, "2026-05-02T12:00:00Z",
        "clean row takes remote modified date"
    );
}

#[test]
fn apply_note_inserts_remote_dates_for_new_rows() {
    let db = open_memory_for_tests();
    let remote = remote_note("note_remote_dates", None, None);
    apply_note_payload(&db, &remote, "uid_dates", "etag_dates", None, true).unwrap();

    let (created, modified): (String, String) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT created, modified FROM notes WHERE id = 'note_remote_dates'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(created, "2026-05-01T12:00:00Z");
    assert_eq!(modified, "2026-05-02T12:00:00Z");
}

#[test]
fn apply_note_merges_tag_crdts_even_when_local_metadata_is_dirty() {
    let db = open_memory_for_tests();
    let local_tags = vec!["local".to_string()];
    let local_state = tags_crdt::init(&local_tags);
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position,
                               created, modified, trashed_at, yrs_state,
                               etebase_uid, etebase_etag, dirty, payload_schema,
                               favourite, note_kind, tags_state)
             VALUES ('note_tags', NULL, 'Local Title', '', 0, 't', 't', NULL, NULL,
                     'uid_tags', 'etag_old', 1, 2, 0, 'markdown', ?1)",
            params![local_state],
        )?;
        c.execute(
            "INSERT INTO note_tags(note_id, tag) VALUES ('note_tags', 'local')",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    let mut remote = remote_note("note_tags", None, None);
    remote.tags = vec!["remote".into()];
    remote.tags_state = tags_crdt::init(&remote.tags);
    apply_note_payload(&db, &remote, "uid_tags", "etag_new", None, true).unwrap();

    let (title, dirty): (String, i64) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT title, dirty FROM notes WHERE id = 'note_tags'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    let tags = db
        .with_conn(|c| load_tags_for_note(c, "note_tags"))
        .unwrap();
    assert_eq!(title, "Local Title");
    assert_eq!(dirty, 1, "merged tags must push back to the server");
    assert_eq!(tags, vec!["local".to_string(), "remote".to_string()]);
}

#[test]
fn apply_note_keeps_dirty_v2_rendered_body() {
    // A scoped sync pulls before it pushes. For v2 markdown rows Rust cannot
    // render the merged XmlFragment back to markdown, so a dirty local row
    // must keep its rendered body through that pull; otherwise the later
    // push uploads the stale remote body and loses the local edit.
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position,
                               created, modified, trashed_at, yrs_state,
                               etebase_uid, etebase_etag, dirty, payload_schema,
                               favourite, note_kind)
             VALUES ('note_body', NULL, 'Local Title', 'local rendered body', 0,
                     't', 't', NULL, NULL, 'uid_body', 'etag_old', 1, 2,
                     0, 'markdown')",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    let mut remote = remote_note("note_body", None, None);
    remote.body = "stale remote body".into();
    apply_note_payload(&db, &remote, "uid_body", "etag_new", Some("scope_1"), true).unwrap();

    let (body, dirty): (String, i64) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT body, dirty FROM notes WHERE id = 'note_body'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(body, "local rendered body");
    assert_eq!(dirty, 1, "local body must still push after the pull");
}

#[test]
fn apply_note_read_only_pull_discards_local_crdt_edits() {
    let db = open_memory_for_tests();
    let local_state = yrs_doc::init_with_markdown("local");
    let local_tags = vec!["local".to_string()];
    let local_tags_state = tags_crdt::init(&local_tags);
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position,
                               created, modified, trashed_at, yrs_state,
                               etebase_uid, etebase_etag, dirty, payload_schema,
                               favourite, note_kind, tags_state, share_scope_id)
             VALUES ('note_read_only', NULL, 'Local Title', 'local rendered', 0,
                     't', 't', NULL, ?1, 'uid_ro', 'etag_old', 1, 2,
                     1, 'markdown', ?2, 'scope_1')",
            params![local_state, local_tags_state],
        )?;
        c.execute(
            "INSERT INTO note_tags(note_id, tag) VALUES ('note_read_only', 'local')",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    let remote_tags = vec!["remote".to_string()];
    let remote = NotePayload {
        schema: 2,
        id: "note_read_only".into(),
        parent_folder_id: None,
        title: "Remote Title".into(),
        position: 7,
        created: Some("2026-05-01T12:00:00Z".into()),
        modified: Some("2026-05-02T12:00:00Z".into()),
        tags: remote_tags.clone(),
        tags_state: tags_crdt::init(&remote_tags),
        trashed_at: None,
        yrs_state: yrs_doc::init_with_markdown("remote"),
        body: "remote rendered".into(),
        crypto_key: vec![],
        favourite: false,
        note_kind: "markdown".into(),
    };

    apply_note_payload(&db, &remote, "uid_ro", "etag_new", Some("scope_1"), false).unwrap();

    let (title, body, dirty, favourite, tags_state): (String, String, i64, i64, Vec<u8>) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT title, body, dirty, favourite, tags_state
                 FROM notes WHERE id = 'note_read_only'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )?)
        })
        .unwrap();
    let tags = db
        .with_conn(|c| load_tags_for_note(c, "note_read_only"))
        .unwrap();

    assert_eq!(title, "Remote Title");
    assert_eq!(body, "remote rendered");
    assert_eq!(dirty, 0);
    assert_eq!(favourite, 0);
    assert_eq!(tags, remote_tags);
    assert_eq!(tags_crdt::tags(&tags_state), remote_tags);
}

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

fn remote_folder(id: &str, parent: Option<&str>, name: &str) -> FolderPayload {
    FolderPayload {
        schema: 1,
        id: id.into(),
        parent_folder_id: parent.map(str::to_string),
        name: name.into(),
        position: 0,
        created: Some("2026-04-01T12:00:00Z".into()),
        modified: Some("2026-04-02T12:00:00Z".into()),
    }
}

#[test]
fn apply_folder_keeps_local_metadata_when_dirty() {
    // An offline folder rename (dirty=1) must not revert to the remote's
    // older name on pull — mirrors the note metadata-preservation path.
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position,
                                     created, modified, etebase_uid, etebase_etag, dirty)
             VALUES ('folder_r', NULL, 'Local Name', 0, 't', 't', 'uid_r', 'etag_old', 1)",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    let remote = remote_folder("folder_r", None, "Remote Name");
    let repaired =
        apply_folder_payload(&db, remote, "uid_r", "etag_new", Some("scope_1"), true).unwrap();
    assert!(
        repaired.is_none(),
        "a dirty folder keeps local parent; skip the parent-repair pass"
    );

    let (name, dirty, scope): (String, i64, Option<String>) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT name, dirty, share_scope_id FROM collections WHERE id = 'folder_r'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?)
        })
        .unwrap();
    assert_eq!(name, "Local Name", "offline rename is preserved");
    assert_eq!(dirty, 1, "row stays dirty so the rename pushes next sync");
    assert_eq!(
        scope.as_deref(),
        Some("scope_1"),
        "the folder is still re-homed into the scope"
    );
    let (created, modified): (String, String) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT created, modified FROM collections WHERE id = 'folder_r'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(created, "t", "dirty folder keeps local created date");
    assert_eq!(modified, "t", "dirty folder keeps local modified date");
}

#[test]
fn apply_folder_takes_remote_metadata_when_clean() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO collections(id, parent_collection_id, name, position,
                                     created, modified, etebase_uid, etebase_etag, dirty)
             VALUES ('folder_c', NULL, 'Old', 0, 't', 't', 'uid_c', 'etag_old', 0)",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    let remote = remote_folder("folder_c", None, "Renamed Remotely");
    apply_folder_payload(&db, remote, "uid_c", "etag_new", None, true).unwrap();

    let (name, created, modified): (String, String, String) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT name, created, modified FROM collections WHERE id = 'folder_c'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?)
        })
        .unwrap();
    assert_eq!(
        name, "Renamed Remotely",
        "a clean folder takes remote metadata"
    );
    assert_eq!(created, "2026-04-01T12:00:00Z");
    assert_eq!(modified, "2026-04-02T12:00:00Z");
}

#[test]
fn apply_remote_delete_removes_a_clean_row() {
    // No unpushed edits: a remote tombstone is a genuine delete.
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position,
                               created, modified, trashed_at, yrs_state,
                               etebase_uid, etebase_etag, dirty, payload_schema,
                               favourite, note_kind)
             VALUES ('n_clean', NULL, 'T', '', 0, 't', 't', NULL, NULL,
                     'uid_clean', 'etag', 0, 2, 0, 'markdown')",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    db.with_conn(|c| apply_remote_delete(c, "notes", "uid_clean"))
        .unwrap();

    let count: i64 = db
        .with_conn(|c| {
            Ok(
                c.query_row("SELECT COUNT(*) FROM notes WHERE id = 'n_clean'", [], |r| {
                    r.get(0)
                })?,
            )
        })
        .unwrap();
    assert_eq!(count, 0, "a clean row is a real delete and is removed");
}

#[test]
fn apply_remote_delete_detaches_a_dirty_row() {
    // Edit-wins-over-delete: an unpushed edit must survive a remote
    // tombstone, detached from the server identity but kept dirty.
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO notes(id, parent_collection_id, title, body, position,
                               created, modified, trashed_at, yrs_state,
                               etebase_uid, etebase_etag, dirty, payload_schema,
                               favourite, note_kind)
             VALUES ('n_dirty', NULL, 'Local edit', '', 0, 't', 't', NULL, NULL,
                     'uid_dirty', 'etag', 1, 2, 0, 'markdown')",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    db.with_conn(|c| apply_remote_delete(c, "notes", "uid_dirty"))
        .unwrap();

    let (uid, etag, dirty, title): (Option<String>, Option<String>, i64, String) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT etebase_uid, etebase_etag, dirty, title
                 FROM notes WHERE id = 'n_dirty'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?)
        })
        .unwrap();
    assert!(uid.is_none(), "detached row drops its server uid");
    assert!(etag.is_none(), "detached row drops its etag");
    assert_eq!(dirty, 1, "row stays dirty so it re-homes on the next push");
    assert_eq!(
        title, "Local edit",
        "the unpushed edit is preserved, not destroyed"
    );
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
