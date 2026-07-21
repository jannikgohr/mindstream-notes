use super::*;

fn invitation(id: &str, collection_uid: &str, collection_type: &str) -> CollectionInvitation {
    CollectionInvitation {
        id: id.to_string(),
        username: "recipient".into(),
        sender_username: Some("sender".into()),
        collection_uid: collection_uid.to_string(),
        access_level: ShareAccessLevel::ReadWrite,
        collection_type: Some(collection_type.to_string()),
    }
}

fn scope_manifest(scope: &str, salt: u8) -> ShareManifest {
    ShareManifest {
        schema: SHARE_MANIFEST_SCHEMA,
        share_scope_id: scope.into(),
        name: "Shared project".into(),
        root_folder_id: "folder_root".into(),
        owner_username: Some("sender".into()),
        collab_epoch: 1,
        collab_salt: vec![salt; SHARE_COLLAB_SALT_BYTES],
        collections: vec![],
    }
}

#[test]
fn select_scope_manifest_returns_the_single_match() {
    let picked = select_scope_manifest(
        "scope_root",
        vec![("col_a".into(), scope_manifest("scope_root", 7))],
    )
    .unwrap()
    .expect("a manifest");

    assert_eq!(picked.collab_salt, vec![7; SHARE_COLLAB_SALT_BYTES]);
}

#[test]
fn select_scope_manifest_returns_none_when_nothing_claims_the_scope() {
    assert!(select_scope_manifest("scope_root", vec![])
        .unwrap()
        .is_none());
}

/// A scope id is unguessable to an outsider, but every member of a scope
/// knows theirs — and anyone can create a collection and share it. A
/// second manifest claiming the scope would otherwise let its author
/// choose the collab salt, and so the live-collab room key, for everyone.
#[test]
fn select_scope_manifest_refuses_when_two_collections_claim_one_scope() {
    let err = select_scope_manifest(
        "scope_root",
        vec![
            ("col_real".into(), scope_manifest("scope_root", 7)),
            ("col_impostor".into(), scope_manifest("scope_root", 9)),
        ],
    )
    .unwrap_err();

    // Must not silently resolve to either one.
    assert!(
        err.to_string().contains("more than one share manifest"),
        "unexpected error: {err}"
    );
}

fn manifest_preview(collections: Vec<ShareManifestCollectionRef>) -> ShareManifestPreview {
    ShareManifestPreview {
        invitation_id: "invite_manifest".into(),
        manifest_collection_uid: "col_manifest".into(),
        manifest: ShareManifest {
            schema: SHARE_MANIFEST_SCHEMA,
            share_scope_id: "scope_root".into(),
            name: "Shared project".into(),
            root_folder_id: "folder_root".into(),
            owner_username: Some("sender".into()),
            collab_epoch: 1,
            collab_salt: vec![7; SHARE_COLLAB_SALT_BYTES],
            collections,
        },
    }
}

fn collection_ref(part: ShareScopePart, collection_uid: &str) -> ShareManifestCollectionRef {
    ShareManifestCollectionRef {
        part,
        collection_uid: collection_uid.to_string(),
        required: true,
    }
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
fn scope_member_remove_errors_are_returned_to_callers() {
    let err = scope_member_remove_error("bob", "col_notes", "remove member: denied".into());
    let AppError::InvalidArg(message) = err else {
        panic!("expected InvalidArg");
    };

    assert!(message.contains("bob"), "{message}");
    assert!(message.contains("col_notes"), "{message}");
    assert!(message.contains("remove member: denied"), "{message}");
}

#[test]
fn manifest_bundle_hides_referenced_invites_and_requires_assets() {
    let invitations = vec![
        invitation(
            "invite_manifest",
            "col_manifest",
            COLLECTION_TYPE_SHARE_MANIFEST,
        ),
        invitation(
            "invite_folders",
            "col_folders",
            COLLECTION_TYPE_SHARE_FOLDERS,
        ),
        invitation("invite_notes", "col_notes", COLLECTION_TYPE_SHARE_NOTES),
        invitation("invite_assets", "col_assets", COLLECTION_TYPE_SHARE_ASSETS),
    ];
    let manifests = vec![manifest_preview(vec![
        collection_ref(ShareScopePart::Folders, "col_folders"),
        collection_ref(ShareScopePart::Notes, "col_notes"),
        collection_ref(ShareScopePart::Assets, "col_assets"),
    ])];

    let result = bundle_incoming_share_invitations(invitations, manifests);

    assert!(result.unbundled_invitations.is_empty());
    assert_eq!(result.bundles.len(), 1);
    let bundle = &result.bundles[0];
    assert!(bundle.complete, "{:?}", bundle.warnings);
    assert!(!bundle.pending);
    assert_eq!(bundle.share_scope_id.as_deref(), Some("scope_root"));
    assert_eq!(bundle.name.as_deref(), Some("Shared project"));
    assert_eq!(bundle.sender_username.as_deref(), Some("sender"));
    assert_eq!(bundle.parts.len(), 3);
    assert!(bundle.parts.iter().any(|part| {
        part.part == ShareScopePart::Assets
            && part.required
            && part.invitation.as_ref().map(|invite| invite.id.as_str()) == Some("invite_assets")
    }));
}

#[test]
fn manifest_without_assets_scope_is_incomplete() {
    let invitations = vec![
        invitation(
            "invite_manifest",
            "col_manifest",
            COLLECTION_TYPE_SHARE_MANIFEST,
        ),
        invitation(
            "invite_folders",
            "col_folders",
            COLLECTION_TYPE_SHARE_FOLDERS,
        ),
        invitation("invite_notes", "col_notes", COLLECTION_TYPE_SHARE_NOTES),
    ];
    let manifests = vec![manifest_preview(vec![
        collection_ref(ShareScopePart::Folders, "col_folders"),
        collection_ref(ShareScopePart::Notes, "col_notes"),
    ])];

    let result = bundle_incoming_share_invitations(invitations, manifests);
    let bundle = &result.bundles[0];

    assert!(!bundle.complete);
    assert!(bundle
        .warnings
        .iter()
        .any(|warning| warning.contains("Assets")));
    assert!(bundle.parts.iter().any(|part| {
        part.part == ShareScopePart::Assets
            && part.required
            && part.collection_uid.is_none()
            && part.invitation.is_none()
    }));
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

#[test]
fn profile_lookup_error_is_friendly_for_missing_user() {
    let friendly = profile_lookup_error("bob", "UserInfo matching query does not exist.");
    let AppError::InvalidArg(message) = friendly else {
        panic!("expected InvalidArg");
    };
    assert!(message.contains("bob"), "{message}");
    assert!(message.contains("sign in once"), "{message}");
    assert!(
        !message.contains("matching query"),
        "raw etebase text should not leak: {message}"
    );

    // Unrelated errors keep their detail for debugging.
    let other = profile_lookup_error("bob", "network unreachable");
    let AppError::InvalidArg(message) = other else {
        panic!("expected InvalidArg");
    };
    assert!(message.contains("network unreachable"), "{message}");
}

#[test]
fn build_share_manifest_lists_three_required_parts() {
    let manifest = build_share_manifest(
        "scope_1",
        "Project X",
        "coll_root",
        Some("alice"),
        "col_folders",
        "col_notes",
        "col_assets",
    );

    assert_eq!(manifest.schema, SHARE_MANIFEST_SCHEMA);
    assert_eq!(manifest.share_scope_id, "scope_1");
    assert_eq!(manifest.root_folder_id, "coll_root");
    assert_eq!(manifest.owner_username.as_deref(), Some("alice"));
    assert_eq!(manifest.collab_epoch, 1);
    assert_eq!(manifest.collab_salt.len(), SHARE_COLLAB_SALT_BYTES);
    assert_eq!(manifest.collections.len(), 3);
    for part in [
        ShareScopePart::Folders,
        ShareScopePart::Notes,
        ShareScopePart::Assets,
    ] {
        let entry = manifest
            .collections
            .iter()
            .find(|collection| collection.part == part)
            .unwrap_or_else(|| panic!("missing {part:?} ref"));
        assert!(entry.required, "{part:?} must be required");
    }

    // Round-trips through the same JSON the receiver's decode_manifest reads.
    let json = serde_json::to_vec(&manifest).unwrap();
    let decoded: ShareManifest = serde_json::from_slice(&json).unwrap();
    assert_eq!(decoded, manifest);
}

#[test]
fn rotate_manifest_collab_secret_increments_epoch_and_replaces_salt() {
    let mut manifest =
        build_share_manifest("scope_1", "Docs", "root", Some("alice"), "f", "n", "a");
    let previous_epoch = manifest.collab_epoch;
    let previous_salt = manifest.collab_salt.clone();

    rotate_manifest_collab_secret(&mut manifest);

    assert_eq!(manifest.schema, SHARE_MANIFEST_SCHEMA);
    assert_eq!(manifest.collab_epoch, previous_epoch + 1);
    assert_eq!(manifest.collab_salt.len(), SHARE_COLLAB_SALT_BYTES);
    assert_ne!(manifest.collab_salt, previous_salt);
}

#[test]
fn accepted_manifest_falls_back_to_part_invitation_for_sender_and_access() {
    // Mirrors a second scan: the manifest has been auto-accepted so its
    // invitation is gone, but the part invitations are still pending. The
    // bundle must still show sender/access, drawn from a part invitation.
    let invitations = vec![
        invitation(
            "invite_folders",
            "col_folders",
            COLLECTION_TYPE_SHARE_FOLDERS,
        ),
        invitation("invite_notes", "col_notes", COLLECTION_TYPE_SHARE_NOTES),
        invitation("invite_assets", "col_assets", COLLECTION_TYPE_SHARE_ASSETS),
    ];
    // Synthetic id == manifest collection uid (no pending manifest invite).
    let mut preview = manifest_preview(vec![
        collection_ref(ShareScopePart::Folders, "col_folders"),
        collection_ref(ShareScopePart::Notes, "col_notes"),
        collection_ref(ShareScopePart::Assets, "col_assets"),
    ]);
    preview.invitation_id = preview.manifest_collection_uid.clone();

    let result = bundle_incoming_share_invitations(invitations, vec![preview]);

    assert_eq!(result.bundles.len(), 1);
    let bundle = &result.bundles[0];
    assert!(bundle.complete, "{:?}", bundle.warnings);
    assert_eq!(bundle.sender_username.as_deref(), Some("sender"));
    assert_eq!(bundle.access_level, Some(ShareAccessLevel::ReadWrite));
    assert!(
        result.unbundled_invitations.is_empty(),
        "part invites must stay bundled even without a manifest invitation"
    );
}

#[test]
fn unreferenced_collection_invites_stay_user_facing() {
    let standalone = invitation("invite_other", "col_other", "custom.collection");
    let invitations = vec![
        invitation(
            "invite_manifest",
            "col_manifest",
            COLLECTION_TYPE_SHARE_MANIFEST,
        ),
        invitation(
            "invite_folders",
            "col_folders",
            COLLECTION_TYPE_SHARE_FOLDERS,
        ),
        invitation("invite_notes", "col_notes", COLLECTION_TYPE_SHARE_NOTES),
        invitation("invite_assets", "col_assets", COLLECTION_TYPE_SHARE_ASSETS),
        standalone.clone(),
    ];
    let manifests = vec![manifest_preview(vec![
        collection_ref(ShareScopePart::Folders, "col_folders"),
        collection_ref(ShareScopePart::Notes, "col_notes"),
        collection_ref(ShareScopePart::Assets, "col_assets"),
    ])];

    let result = bundle_incoming_share_invitations(invitations, manifests);

    assert_eq!(result.unbundled_invitations, vec![standalone]);
}

#[test]
fn unopened_manifest_surfaces_as_pending_bundle_and_hides_its_parts() {
    // The scan hasn't accepted the manifest (no opened manifests), so the
    // manifest invite becomes a pending preview bundle and its part invites
    // stay hidden rather than leaking as lone collaboration invites.
    let invitations = vec![
        invitation(
            "invite_manifest",
            "col_manifest",
            COLLECTION_TYPE_SHARE_MANIFEST,
        ),
        invitation(
            "invite_folders",
            "col_folders",
            COLLECTION_TYPE_SHARE_FOLDERS,
        ),
        invitation("invite_notes", "col_notes", COLLECTION_TYPE_SHARE_NOTES),
        invitation("invite_assets", "col_assets", COLLECTION_TYPE_SHARE_ASSETS),
    ];

    let result = assemble_incoming_share_bundles(invitations, Vec::new());

    assert!(result.unbundled_invitations.is_empty());
    assert_eq!(result.bundles.len(), 1);
    let bundle = &result.bundles[0];
    assert!(bundle.pending);
    assert_eq!(bundle.manifest_collection_uid, "col_manifest");
    assert_eq!(bundle.sender_username.as_deref(), Some("sender"));
    assert_eq!(bundle.access_level, Some(ShareAccessLevel::ReadWrite));
    assert!(bundle.name.is_none());
    assert!(bundle.parts.is_empty());
    // Accept is still offered for a pending bundle.
    assert!(bundle.complete);
}

#[test]
fn opened_manifest_with_all_parts_accepted_stops_showing() {
    // Manifest opened (member), and every part accepted (no pending part
    // invites): the share is fully accepted, so it must not linger.
    let opened = vec![manifest_preview(vec![
        collection_ref(ShareScopePart::Folders, "col_folders"),
        collection_ref(ShareScopePart::Notes, "col_notes"),
        collection_ref(ShareScopePart::Assets, "col_assets"),
    ])];

    let result = assemble_incoming_share_bundles(Vec::new(), opened);

    assert!(result.bundles.is_empty());
    assert!(result.unbundled_invitations.is_empty());
}

#[test]
fn opened_manifest_with_pending_parts_still_shows_to_finish_accept() {
    // Manifest opened but the part invites are still pending (a resumed,
    // partially-accepted share): keep showing so the user can finish.
    let invitations = vec![
        invitation(
            "invite_folders",
            "col_folders",
            COLLECTION_TYPE_SHARE_FOLDERS,
        ),
        invitation("invite_notes", "col_notes", COLLECTION_TYPE_SHARE_NOTES),
        invitation("invite_assets", "col_assets", COLLECTION_TYPE_SHARE_ASSETS),
    ];
    let opened = vec![manifest_preview(vec![
        collection_ref(ShareScopePart::Folders, "col_folders"),
        collection_ref(ShareScopePart::Notes, "col_notes"),
        collection_ref(ShareScopePart::Assets, "col_assets"),
    ])];

    let result = assemble_incoming_share_bundles(invitations, opened);

    assert_eq!(result.bundles.len(), 1);
    let bundle = &result.bundles[0];
    assert!(!bundle.pending);
    assert_eq!(bundle.name.as_deref(), Some("Shared project"));
    assert!(bundle.complete, "{:?}", bundle.warnings);
}

// ---- Incomplete-bundle guards ----

#[test]
fn manifest_missing_required_parts_flags_absent_parts() {
    let full = manifest_preview(vec![
        collection_ref(ShareScopePart::Folders, "f"),
        collection_ref(ShareScopePart::Notes, "n"),
        collection_ref(ShareScopePart::Assets, "a"),
    ])
    .manifest;
    assert!(manifest_missing_required_parts(&full).is_empty());

    let no_assets = manifest_preview(vec![
        collection_ref(ShareScopePart::Folders, "f"),
        collection_ref(ShareScopePart::Notes, "n"),
    ])
    .manifest;
    assert_eq!(
        manifest_missing_required_parts(&no_assets),
        vec![ShareScopePart::Assets]
    );

    let empty = manifest_preview(vec![]).manifest;
    assert_eq!(
        manifest_missing_required_parts(&empty),
        vec![
            ShareScopePart::Folders,
            ShareScopePart::Notes,
            ShareScopePart::Assets
        ]
    );
}

#[test]
fn build_share_manifest_is_structurally_complete() {
    // The invite-time assertion (validate_scope_complete) relies on a fresh
    // manifest never being missing a part.
    let manifest = build_share_manifest("scope_1", "Docs", "root", Some("alice"), "f", "n", "a");
    assert!(manifest_missing_required_parts(&manifest).is_empty());
}

#[test]
fn unsatisfiable_required_parts_detects_missing_invite_and_missing_ref() {
    let manifest = manifest_preview(vec![
        collection_ref(ShareScopePart::Folders, "f"),
        collection_ref(ShareScopePart::Notes, "n"),
        collection_ref(ShareScopePart::Assets, "a"),
    ])
    .manifest;

    // All three referenced parts satisfiable (invitation or member) → OK.
    let all: HashSet<&str> = ["f", "n", "a"].into_iter().collect();
    assert!(unsatisfiable_required_parts(&manifest, &all).is_empty());

    // Assets referenced but not satisfiable (no invite, not a member).
    let missing_assets: HashSet<&str> = ["f", "n"].into_iter().collect();
    assert_eq!(
        unsatisfiable_required_parts(&manifest, &missing_assets),
        vec![ShareScopePart::Assets]
    );

    // A manifest that doesn't reference assets at all is unsatisfiable even
    // if some stray uid happens to be "satisfiable".
    let no_ref = manifest_preview(vec![
        collection_ref(ShareScopePart::Folders, "f"),
        collection_ref(ShareScopePart::Notes, "n"),
    ])
    .manifest;
    let stray: HashSet<&str> = ["f", "n", "a"].into_iter().collect();
    assert_eq!(
        unsatisfiable_required_parts(&no_ref, &stray),
        vec![ShareScopePart::Assets]
    );
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
        for kind in ["scope-folders:scope_x", "scope-notes:scope_x", "scope-assets:scope_x"] {
            conn.execute(
                "INSERT INTO sync_state(kind, stoken) VALUES (?1, 's')",
                params![kind],
            )?;
        }
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
                (SELECT COUNT(*) FROM sync_state WHERE kind LIKE 'scope-%:scope_x')",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(remaining, 0);
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
