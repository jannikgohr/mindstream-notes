//! Opt-in checks against a running development sync server with open signup.
//! MINDSTREAM_TEST_SERVER_URL selects it (defaults to http://127.0.0.1:13735).

use super::fixtures::remote_note;
use super::*;

#[test]
fn dirty_notes_load_only_their_own_sorted_tags_in_the_requested_space() {
    let db = open_memory_for_tests();
    db.with_conn(|conn| {
        for (id, dirty, scope) in [("vault", 1, None), ("shared", 1, Some("space")), ("clean", 0, None)] {
            conn.execute(
                "INSERT INTO notes (id, title, body, position, created, modified, dirty, share_scope_id)
                 VALUES (?1, 'N', '', 0, 't', 't', ?2, ?3)",
                params![id, dirty, scope],
            )?;
            for tag in ["z", "a"] {
                conn.execute("INSERT INTO note_tags (note_id, tag) VALUES (?1, ?2)", params![id, format!("{tag}-{id}")])?;
            }
        }
        Ok(())
    }).unwrap();
    for (scope, id) in [(None, "vault"), (Some("space"), "shared")] {
        let notes = load_dirty_notes(&db, scope).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].id, id);
        assert_eq!(notes[0].tags, [format!("a-{id}"), format!("z-{id}")]);
        assert_eq!(tags_crdt::tags(&notes[0].tags_state), notes[0].tags);
    }
    assert!(load_dirty_notes(&db, Some("empty")).unwrap().is_empty());
}

#[test]
#[ignore = "needs a development sync server with open signup"]
fn push_preserves_keys_with_a_current_stale_missing_or_unreadable_cache() {
    let url = std::env::var("MINDSTREAM_TEST_SERVER_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:13735".into());
    let username = format!("push-{}", uuid::Uuid::new_v4());
    let account = Account::signup_key(
        etebase::Client::new("push-cache-test", &url).unwrap(),
        &etebase::User::new(&username, "test@example.com"),
        &randombytes(32),
    )
    .unwrap();
    let cm = account.collection_manager().unwrap();
    let collection = cm
        .create(COLLECTION_TYPE_VAULT, &ItemMetadata::new(), b"")
        .unwrap();
    cm.upload(&collection, None).unwrap();
    let im = cm.item_manager(&collection).unwrap();
    let db = open_memory_for_tests();
    let seal = room_keys::Seal::from_session_secret(&[7; 32]).unwrap();
    let wrong_seal = room_keys::Seal::from_session_secret(&[8; 32]).unwrap();
    let mut meta = ItemMetadata::new();
    meta.set_item_type(Some(ITEM_TYPE_NOTE));

    for mode in [
        "current",
        "pulled",
        "stale",
        "missing",
        "unreadable",
        "legacy",
        "moved",
    ] {
        let mut payload = remote_note(mode, None, None);
        payload.crypto_key = vec![1; 32];
        payload.body = "old body".repeat(10000);
        let mut item = im
            .create(&meta, &rmp_serde::to_vec_named(&payload).unwrap())
            .unwrap();
        im.batch([&item].into_iter(), None).unwrap();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO notes (id, title, body, position, created, modified, dirty, etebase_uid)
                 VALUES (?1, 'Local title', 'new body', 0, 't', 't', 1, ?2)",
                params![mode, item.uid()],
            )?;
            Ok(())
        }).unwrap();

        let mut learned = room_keys::Learned::default();
        if mode != "missing" {
            learned.note(mode, &payload.crypto_key, item.uid(), item.etag());
            if mode != "pulled" {
                room_keys::keep(&db, Some(&seal), std::mem::take(&mut learned)).unwrap();
            }
        }
        if mode == "legacy" {
            db.with_conn(|conn| room_keys::store(conn, &seal, mode, &payload.crypto_key))
                .unwrap();
        }
        if mode == "stale" || mode == "moved" {
            payload.crypto_key = vec![2; 32];
            let bytes = rmp_serde::to_vec_named(&payload).unwrap();
            if mode == "moved" {
                item = im.create(&meta, &bytes).unwrap();
                db.with_conn(|conn| {
                    conn.execute(
                        "UPDATE notes SET etebase_uid = ?1 WHERE id = ?2",
                        params![item.uid(), mode],
                    )?;
                    Ok(())
                })
                .unwrap();
            } else {
                item.set_content(&bytes).unwrap();
            }
            im.batch([&item].into_iter(), None).unwrap();
        }

        let mut report = SyncReport::default();
        push_notes(
            &db,
            &im,
            &mut report,
            None,
            &mut learned,
            Some(if mode == "unreadable" {
                &wrong_seal
            } else {
                &seal
            }),
        )
        .unwrap();
        assert_eq!(report.notes_pushed, 1, "{mode}");
        let pushed = im.fetch(item.uid(), None).unwrap();
        let actual: NotePayload = rmp_serde::from_slice(&pushed.content().unwrap()).unwrap();
        assert_eq!(actual.crypto_key, payload.crypto_key, "{mode}");
        assert_eq!(actual.body, "new body", "{mode}");
        assert_eq!(
            learned.for_revision(mode, pushed.uid(), pushed.etag()),
            Some(payload.crypto_key.as_slice()),
            "{mode}"
        );
        if mode == "current" {
            // A writer changed the item after our read. Retrying must ride
            // its revision while keeping our edit and the room key.
            let mut local = pushed.clone();
            let mut remote = pushed;
            let mut local_payload = actual;
            local_payload.body = "local conflict edit".into();
            local
                .set_content(&rmp_serde::to_vec_named(&local_payload).unwrap())
                .unwrap();
            remote
                .set_content(&rmp_serde::to_vec_named(&payload).unwrap())
                .unwrap();
            im.batch([&remote].into_iter(), None).unwrap();
            let mut conflicts = 0;
            transact_or_resolve(&im, std::slice::from_mut(&mut local), &mut conflicts).unwrap();
            assert_eq!(conflicts, 1);
            let merged = im.fetch(local.uid(), None).unwrap();
            let merged: NotePayload = rmp_serde::from_slice(&merged.content().unwrap()).unwrap();
            assert_eq!(merged.body, local_payload.body);
            assert_eq!(merged.crypto_key, local_payload.crypto_key);
        }
    }
}
