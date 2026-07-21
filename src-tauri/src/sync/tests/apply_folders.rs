//! Folder placement merges and remote deletes.

use super::fixtures::*;
use super::*;

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
