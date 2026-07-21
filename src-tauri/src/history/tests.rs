use super::*;
use crate::db::open_memory_for_tests;
use crate::notes::{create, CreateNote};

fn make_note(db: &Db) -> String {
    db.with_conn(|c| {
        create(
            c,
            CreateNote {
                title: Some("Doc".into()),
                body: Some("hello".into()),
                parent_collection_id: None,
                note_kind: Some("markdown".into()),
            },
        )
    })
    .unwrap()
    .summary
    .id
}

fn cap(db: &Db, note: &str, action: &str, refv: Option<&str>, md: &str) -> Option<VersionSummary> {
    db.with_conn(|c| capture(c, note, "markdown", action, refv, md))
        .unwrap()
}

#[test]
fn first_capture_is_promoted_to_created() {
    let db = open_memory_for_tests();
    let note = make_note(&db);
    let v = cap(&db, &note, "edited", None, "hello world").unwrap();
    assert_eq!(v.action, "created");
    // created vs empty baseline → 2 words added.
    assert_eq!(v.words_added, 2);
    assert_eq!(v.words_removed, 0);
}

#[test]
fn identical_content_dedups() {
    let db = open_memory_for_tests();
    let note = make_note(&db);
    cap(&db, &note, "edited", None, "same text");
    let again = cap(&db, &note, "edited", None, "same text");
    assert!(
        again.is_none(),
        "unchanged snapshot must not create a version"
    );
    assert_eq!(db.with_conn(|c| list(c, &note)).unwrap().len(), 1);
}

#[test]
fn formatting_only_edit_has_tokens_but_no_words() {
    let db = open_memory_for_tests();
    let note = make_note(&db);
    cap(&db, &note, "edited", None, "hello world");
    let v = cap(&db, &note, "edited", None, "**hello** world").unwrap();
    assert_eq!((v.words_added, v.words_removed), (0, 0));
    assert_eq!(v.tokens_added, 4); // four '*'
    assert_eq!(v.tokens_removed, 0);
}

#[test]
fn non_markdown_capture_uses_size_delta_without_text_diff() {
    let db = open_memory_for_tests();
    let note = make_note(&db);
    let first = db
        .with_conn(|c| capture(c, &note, "freeform", "edited", None, "abc"))
        .unwrap()
        .unwrap();
    assert_eq!((first.words_added, first.words_removed), (0, 0));
    assert_eq!((first.tokens_added, first.tokens_removed), (3, 0));

    let second = db
        .with_conn(|c| capture(c, &note, "freeform", "edited", None, "a"))
        .unwrap()
        .unwrap();
    assert_eq!((second.words_added, second.words_removed), (0, 0));
    assert_eq!((second.tokens_added, second.tokens_removed), (0, 2));
}

#[test]
fn current_non_markdown_snapshot_wraps_saved_yrs_state() {
    let db = open_memory_for_tests();
    let note = db
        .with_conn(|c| {
            create(
                c,
                CreateNote {
                    title: Some("Canvas".into()),
                    body: Some(String::new()),
                    parent_collection_id: None,
                    note_kind: Some("freeform".into()),
                },
            )
        })
        .unwrap()
        .summary
        .id;
    db.with_conn(|c| {
        c.execute(
            "UPDATE notes SET yrs_state = ?2 WHERE id = ?1",
            rusqlite::params![&note, vec![1u8, 2, 3]],
        )?;
        Ok(())
    })
    .unwrap();

    let (kind, snapshot) = db
        .with_conn(|c| current_note_snapshot(c, &note))
        .expect("snapshot");
    let parsed: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
    assert_eq!(kind, "freeform");
    assert_eq!(parsed["marker"], SNAPSHOT_MARKER);
    assert_eq!(parsed["noteKind"], "freeform");
    assert_eq!(parsed["payloadKind"], "yjs-update");
    assert_eq!(
        parsed["data"],
        base64::Engine::encode(&BASE64_STANDARD, [1u8, 2, 3])
    );
}

#[test]
fn current_markdown_snapshot_keeps_body_verbatim() {
    let db = open_memory_for_tests();
    let note = make_note(&db);

    let (kind, snapshot) = db
        .with_conn(|c| current_note_snapshot(c, &note))
        .expect("snapshot");

    assert_eq!(kind, "markdown");
    assert_eq!(snapshot, "hello");
}

#[test]
fn missing_note_snapshot_reports_not_found() {
    let db = open_memory_for_tests();

    let res = db.with_conn(|c| read_note_raw(c, "missing-note"));
    assert!(matches!(res, Err(AppError::NotFound(_))));
}

#[test]
fn magnitude_counts_word_churn() {
    let db = open_memory_for_tests();
    let note = make_note(&db);
    cap(&db, &note, "edited", None, "alpha beta gamma");
    let v = cap(&db, &note, "edited", None, "alpha delta gamma epsilon").unwrap();
    assert_eq!(v.action, "edited");
    assert_eq!(v.words_added, 2); // delta, epsilon
    assert_eq!(v.words_removed, 1); // beta
}

#[test]
fn compress_round_trips_through_load() {
    let db = open_memory_for_tests();
    let note = make_note(&db);
    let md = "# Heading\n\nA paragraph with *emphasis* and a list:\n- one\n- two\n";
    let v = cap(&db, &note, "edited", None, md).unwrap();
    let loaded = db.with_conn(|c| load(c, &v.id)).unwrap();
    assert_eq!(loaded.body, md);
}

#[test]
fn revert_denormalises_target_timestamp() {
    let db = open_memory_for_tests();
    let note = make_note(&db);
    let target = cap(&db, &note, "edited", None, "original").unwrap();
    cap(&db, &note, "edited", None, "changed");
    let rev = cap(&db, &note, "reverted", Some(&target.id), "original").unwrap();
    assert_eq!(rev.action, "reverted");
    assert_eq!(rev.ref_version_id.as_deref(), Some(target.id.as_str()));
    assert_eq!(rev.ref_created.as_deref(), Some(target.created.as_str()));
}

#[test]
fn list_is_newest_first() {
    let db = open_memory_for_tests();
    let note = make_note(&db);
    let a = cap(&db, &note, "edited", None, "one").unwrap();
    let b = cap(&db, &note, "edited", None, "two").unwrap();
    let ids: Vec<String> = db
        .with_conn(|c| list(c, &note))
        .unwrap()
        .into_iter()
        .map(|v| v.id)
        .collect();
    assert_eq!(ids, vec![b.id, a.id]);
}

#[test]
fn prune_removes_old_and_forever_keeps_all() {
    let db = open_memory_for_tests();
    let note = make_note(&db);
    let v = cap(&db, &note, "edited", None, "content").unwrap();
    // Backdate it 100 days.
    let old = (Utc::now() - chrono::Duration::days(100)).to_rfc3339();
    db.with_conn(|c| {
        c.execute(
            "UPDATE note_versions SET created = ?2 WHERE id = ?1",
            params![v.id, old],
        )
        .map(|_| ())
        .map_err(Into::into)
    })
    .unwrap();

    // Forever (None) keeps it.
    assert_eq!(db.with_conn(|c| prune(c, None)).unwrap(), 0);
    assert_eq!(db.with_conn(|c| list(c, &note)).unwrap().len(), 1);

    // 90-day retention sweeps it.
    assert_eq!(db.with_conn(|c| prune(c, Some(90))).unwrap(), 1);
    assert!(db.with_conn(|c| list(c, &note)).unwrap().is_empty());
}

#[test]
fn purging_note_cascades_to_versions() {
    let db = open_memory_for_tests();
    let note = make_note(&db);
    cap(&db, &note, "edited", None, "content");
    db.with_conn(|c| crate::notes::purge(c, &note)).unwrap();
    assert!(db.with_conn(|c| list(c, &note)).unwrap().is_empty());
}
