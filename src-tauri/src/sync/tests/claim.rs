//! Which space may write a row, and how a row is let go.

use super::*;

/// A note row with the given home. `uid` is its item in that home, if it
/// has one.
fn note(conn: &Connection, id: &str, scope: Option<&str>, uid: Option<&str>, dirty: i64) {
    conn.execute(
        "INSERT INTO notes(id, title, body, position, created, modified,
                           share_scope_id, etebase_uid, etebase_etag, dirty)
         VALUES (?1, ?1, '', 0, 't', 't', ?2, ?3, 'etag', ?4)",
        params![id, scope, uid, dirty],
    )
    .unwrap();
}

fn claimable(db: &Db, id: &str, scope: Option<&str>) -> bool {
    db.with_conn(|c| may_claim(c, "notes", id, scope)).unwrap()
}

#[test]
fn row_that_does_not_exist_yet_is_anyones_to_create() {
    let db = open_memory_for_tests();
    assert!(claimable(&db, "new", None));
    assert!(claimable(&db, "new", Some("share_a")));
}

#[test]
fn item_may_write_a_row_of_its_own_space() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        note(c, "mine", None, Some("uid_v"), 0);
        note(c, "shared", Some("share_a"), Some("uid_a"), 0);
        // Not uploaded yet, and still its own space's.
        note(c, "draft", Some("share_a"), None, 1);
        Ok(())
    })
    .unwrap();

    assert!(claimable(&db, "mine", None));
    assert!(claimable(&db, "shared", Some("share_a")));
    assert!(claimable(&db, "draft", Some("share_a")));
}

/// The attack this rule exists for: someone who can write to a folder
/// shared with you puts an item there that carries the id of one of your
/// own notes.
#[test]
fn item_in_a_shared_folder_cannot_take_over_a_note_of_the_vault() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        note(c, "mine", None, Some("uid_v"), 0);
        note(c, "mine_edited", None, Some("uid_v2"), 1);
        // New on this device and not uploaded yet. Still mine.
        note(c, "mine_new", None, None, 1);
        Ok(())
    })
    .unwrap();

    for id in ["mine", "mine_edited", "mine_new"] {
        assert!(!claimable(&db, id, Some("share_a")), "{id}");
    }
}

#[test]
fn item_cannot_take_over_a_row_of_another_shared_folder_or_pull_one_into_the_vault() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        note(c, "in_a", Some("share_a"), Some("uid_a"), 0);
        // Moved into share A on this device, waiting to be uploaded there.
        note(c, "to_a", Some("share_a"), None, 1);
        Ok(())
    })
    .unwrap();

    for id in ["in_a", "to_a"] {
        assert!(
            !claimable(&db, id, Some("share_b")),
            "{id} by another share"
        );
        assert!(!claimable(&db, id, None), "{id} by the vault");
    }
}

/// A note on its way into a shared folder, seen from a second device that
/// has unsent edits to it. The vault deletes its item, which lets the row
/// go, and only then may the shared folder take it.
#[test]
fn row_its_home_has_let_go_of_may_be_claimed_by_another_space() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        note(c, "moving", None, Some("uid_v"), 1);
        Ok(())
    })
    .unwrap();
    assert!(!claimable(&db, "moving", Some("share_a")));

    db.with_conn(|c| apply_remote_delete(c, "notes", "uid_v", None))
        .unwrap();

    assert!(claimable(&db, "moving", Some("share_a")));
    // It is still the vault's to keep, should nothing claim it.
    assert!(claimable(&db, "moving", None));
}

#[test]
fn deletion_lets_go_of_an_edited_row_and_removes_a_clean_one() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        note(c, "edited", None, Some("uid_edited"), 1);
        note(c, "clean", None, Some("uid_clean"), 0);
        apply_remote_delete(c, "notes", "uid_edited", None)?;
        apply_remote_delete(c, "notes", "uid_clean", None)?;

        let (uid, released, dirty): (Option<String>, i64, i64) = c.query_row(
            "SELECT etebase_uid, released, dirty FROM notes WHERE id = 'edited'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        assert_eq!((uid, released, dirty), (None, 1, 1));
        let clean: i64 = c.query_row("SELECT COUNT(*) FROM notes WHERE id = 'clean'", [], |r| {
            r.get(0)
        })?;
        assert_eq!(clean, 0);
        Ok(())
    })
    .unwrap();
}

/// An item's uid means something in its own collection only. A deletion
/// in one space must not reach a row of another that happens to carry the
/// same uid, which a hostile member could arrange.
#[test]
fn deletion_reaches_only_rows_of_the_space_it_came_from() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        note(c, "mine", None, Some("uid_same"), 0);
        note(c, "mine_edited", None, Some("uid_same_2"), 1);
        apply_remote_delete(c, "notes", "uid_same", Some("share_a"))?;
        apply_remote_delete(c, "notes", "uid_same_2", Some("share_a"))?;

        let rows: Vec<(String, Option<String>, i64)> = c
            .prepare("SELECT id, etebase_uid, released FROM notes ORDER BY id")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        assert_eq!(
            rows,
            vec![
                ("mine".to_string(), Some("uid_same".to_string()), 0),
                ("mine_edited".to_string(), Some("uid_same_2".to_string()), 0),
            ]
        );
        Ok(())
    })
    .unwrap();
}

/// Being put in a space on this device gives a row somewhere to go, so it
/// stops being up for grabs.
#[test]
fn moving_a_released_row_locally_takes_the_mark_off() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO collections(id, name, position, created, modified, dirty)
             VALUES ('folder', 'F', 0, 't', 't', 0)",
            [],
        )?;
        note(c, "moving", None, Some("uid_v"), 1);
        c.execute(
            "UPDATE notes SET parent_collection_id = 'folder' WHERE id = 'moving'",
            [],
        )?;
        apply_remote_delete(c, "notes", "uid_v", None)?;
        assert!(may_claim(c, "notes", "moving", Some("share_b"))?);

        crate::sharing::rehome_folder_subtree(c, "folder", Some("share_a"))?;

        assert!(!may_claim(c, "notes", "moving", Some("share_b"))?);
        assert!(may_claim(c, "notes", "moving", Some("share_a"))?);
        Ok(())
    })
    .unwrap();
}

/// An attachment lives where its note does. One that names a note in
/// another space is somebody attaching to a note that is not theirs.
#[test]
fn asset_is_not_attached_to_a_note_of_another_space() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        note(c, "mine", None, Some("uid_v"), 0);
        note(c, "shared", Some("share_a"), Some("uid_a"), 0);
        Ok(())
    })
    .unwrap();
    let asset = |id: &str, note_id: &str| AssetPayload {
        schema: 1,
        id: id.into(),
        owning_note_id: note_id.into(),
        mime_type: "image/png".into(),
        bytes: vec![1, 2, 3],
        size: 3,
        created: "t".into(),
        modified: "t".into(),
    };

    let foreign =
        apply_asset_payload(&db, &asset("a1", "mine"), "uid_a1", "etag", Some("share_a")).unwrap();
    assert!(matches!(foreign, ApplyAssetOutcome::Orphaned));
    let own = apply_asset_payload(
        &db,
        &asset("a2", "shared"),
        "uid_a2",
        "etag",
        Some("share_a"),
    )
    .unwrap();
    assert!(matches!(own, ApplyAssetOutcome::Applied(_)));
    let count: i64 = db
        .with_conn(|c| Ok(c.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn cursor_waits_a_bounded_number_of_syncs_for_a_refused_item() {
    // A row that is moving is settled by the next sync. What is still
    // refused after the last wait is dropped.
    let mut waited = 0;
    let mut waits = 0;
    while let Some(count) = hold_again(waited) {
        waited = count;
        waits += 1;
        assert!(waits < 100, "the waiting never ends");
    }
    assert_eq!(waits, MAX_HOLDS - 1);
    assert_eq!(hold_again(MAX_HOLDS), None);
    assert_eq!(held_key("scope:abc"), "held:scope:abc");
}
