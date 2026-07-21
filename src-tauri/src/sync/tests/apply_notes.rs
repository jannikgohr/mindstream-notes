//! How a pulled note payload meets the local row.

use super::fixtures::*;
use super::*;

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
