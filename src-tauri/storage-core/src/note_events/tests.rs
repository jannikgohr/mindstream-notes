use rusqlite::{params, Connection};

use super::*;
use crate::notes::{self, CreateNote, NoteKind, UpdateNote};

fn vault() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    crate::migrations::run(&mut conn).unwrap();
    conn
}

fn create(conn: &Connection, kind: NoteKind) -> String {
    let note = notes::create(
        conn,
        CreateNote {
            title: Some("note".into()),
            body: Some(String::new()),
            parent_collection_id: None,
            note_kind: Some(kind),
        },
    )
    .unwrap();
    settle(conn, &note.summary.id);
    note.summary.id
}

fn edit(conn: &mut Connection, id: &str, body: &str) {
    notes::update(
        conn,
        UpdateNote {
            id: id.into(),
            title: None,
            body: Some(body.into()),
            parent_collection_id: None,
            position: None,
            tags: None,
            yrs_state: None,
            favourite: None,
        },
    )
    .unwrap();
}

/// Moves the note's last change into the past, as if it had settled.
fn settle(conn: &Connection, id: &str) {
    conn.execute("UPDATE notes SET changed_at = 0 WHERE id = ?1", params![id])
        .unwrap();
}

fn delivered(pending: &Pending) -> Vec<&str> {
    pending
        .changes
        .iter()
        .map(|change| change.note_id.as_str())
        .collect()
}

fn set_up() -> serde_json::Value {
    serde_json::json!({ "endpoint": "http://localhost" })
}

fn ink() -> Option<Vec<String>> {
    Some(vec!["ink".to_string()])
}

#[test]
fn content_writes_number_the_note_and_other_writes_do_not() {
    let mut conn = vault();
    let a = create(&conn, NoteKind::Markdown);
    let b = create(&conn, NoteKind::Markdown);
    let seq = |conn: &Connection, id: &str| -> i64 {
        conn.query_row(
            "SELECT change_seq FROM notes WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert!(seq(&conn, &b) > seq(&conn, &a));

    edit(&mut conn, &a, "changed");
    let after_edit = seq(&conn, &a);
    assert!(after_edit > seq(&conn, &b));

    edit(&mut conn, &a, "changed");
    conn.execute(
        "UPDATE notes SET pdf_text = 'derived', favourite = 1 WHERE id = ?1",
        params![a],
    )
    .unwrap();
    assert_eq!(seq(&conn, &a), after_edit);

    // Ink notes and synced edits are saved as editor state.
    notes::save_yrs_state(&mut conn, &a, &crate::yrs_doc::init_with_markdown("ink")).unwrap();
    assert!(seq(&conn, &a) > after_edit);
}

#[test]
fn delivers_settled_changes_in_order_and_stops_at_a_settling_note() {
    let mut conn = vault();
    let first = create(&conn, NoteKind::Ink);
    let markdown = create(&conn, NoteKind::Markdown);
    let second = create(&conn, NoteKind::Ink);
    edit(&mut conn, &markdown, "still typing");
    let found = pending(
        &conn,
        "p",
        "noteChanged",
        &set_up(),
        ink().as_deref(),
        5000,
        10,
    )
    .unwrap();
    assert_eq!(delivered(&found), [first.as_str(), second.as_str()]);
    assert_eq!(found.changes[0].kind, "ink");

    edit(&mut conn, &first, "typing");
    let found = pending(&conn, "p", "noteChanged", &set_up(), None, 5000, 10).unwrap();
    assert_eq!(delivered(&found), [second.as_str()]);

    settle(&conn, &markdown);
    settle(&conn, &first);
    let all = pending(&conn, "p", "noteChanged", &set_up(), None, 5000, 10).unwrap();
    assert_eq!(
        delivered(&all),
        [second.as_str(), markdown.as_str(), first.as_str()]
    );
}

#[test]
fn trashed_notes_send_nothing_and_do_not_hold_the_cursor() {
    let mut conn = vault();
    let trashed = create(&conn, NoteKind::Ink);
    let kept = create(&conn, NoteKind::Ink);
    edit(&mut conn, &trashed, "about to go");
    notes::trash(&conn, &trashed).unwrap();
    let found = pending(&conn, "p", "noteChanged", &set_up(), None, 5000, 10).unwrap();
    assert_eq!(delivered(&found), [kept.as_str()]);
}

#[test]
fn the_cursor_moves_only_with_its_own_generation() {
    let mut conn = vault();
    let a = create(&conn, NoteKind::Ink);
    let b = create(&conn, NoteKind::Ink);
    let first = pending(&conn, "p", "noteChanged", &set_up(), None, 0, 10).unwrap();
    commit(
        &conn,
        "p",
        "noteChanged",
        &first.generation,
        first.changes[0].revision,
    )
    .unwrap();
    assert_eq!(
        delivered(&pending(&conn, "p", "noteChanged", &set_up(), None, 0, 10).unwrap()),
        [b.as_str()]
    );
    // Another export of the same plugin keeps its own place.
    assert_eq!(
        delivered(&pending(&conn, "p", "other", &set_up(), None, 0, 10).unwrap()),
        [a.as_str(), b.as_str()]
    );

    // New settings start over, and a delivery that began before cannot
    // move the new cursor.
    let changed = serde_json::json!({ "endpoint": "http://elsewhere" });
    assert_eq!(
        delivered(&pending(&conn, "p", "noteChanged", &changed, None, 0, 10).unwrap()),
        [a.as_str(), b.as_str()]
    );
    commit(
        &conn,
        "p",
        "noteChanged",
        &first.generation,
        first.changes[1].revision,
    )
    .unwrap();
    assert_eq!(
        delivered(&pending(&conn, "p", "noteChanged", &changed, None, 0, 10).unwrap()),
        [a.as_str(), b.as_str()]
    );

    let again = pending(&conn, "p", "noteChanged", &set_up(), None, 0, 10).unwrap();
    commit(
        &conn,
        "p",
        "noteChanged",
        &again.generation,
        again.changes[1].revision,
    )
    .unwrap();
    forget(&conn, "p").unwrap();
    commit(
        &conn,
        "p",
        "noteChanged",
        &again.generation,
        again.changes[1].revision,
    )
    .unwrap();
    edit(&mut conn, &a, "new");
    settle(&conn, &a);
    assert_eq!(
        delivered(&pending(&conn, "p", "noteChanged", &set_up(), None, 0, 10).unwrap()),
        [b.as_str(), a.as_str()]
    );
}

#[test]
fn a_purge_does_not_hand_out_a_delivered_number_again() {
    let conn = vault();
    create(&conn, NoteKind::Ink);
    let newest = create(&conn, NoteKind::Ink);
    let all = pending(&conn, "p", "noteChanged", &set_up(), None, 0, 10).unwrap();
    let last = all.changes.last().unwrap().revision;
    commit(&conn, "p", "noteChanged", &all.generation, last).unwrap();
    notes::trash(&conn, &newest).unwrap();
    notes::purge(&conn, &newest).unwrap();

    let next = create(&conn, NoteKind::Ink);
    assert_eq!(
        delivered(&pending(&conn, "p", "noteChanged", &set_up(), None, 0, 10).unwrap()),
        [next.as_str()]
    );
}
