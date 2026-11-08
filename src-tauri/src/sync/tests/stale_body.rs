//! A device whose rendered body lags its CRDT must not roll other devices
//! back, and must not get an image deleted that the CRDT still shows.
//!
//! Regression for a note that lost a GIF after a server switch: logging into
//! the new server dirtied every row on both devices, the second device to
//! sync kept its weeks-old rendered body over the merged state, every other
//! device took that body, and the attachment sweep on the second device
//! freed the GIF because the stale body no longer linked it.

use super::fixtures::*;
use super::*;

const GIF: &str = "asset_9f1f2e3d-0000-4000-8000-00000000c0de";

fn gif_link() -> String {
    format!("asset:mindstream/{GIF}")
}

/// The note as the desktop wrote it: the shared draft plus a paragraph and
/// the GIF, both added after the phone last saw the note.
fn desktop_state(base: &[u8]) -> Vec<u8> {
    yrs_doc::append_editor_block_for_tests(base, 101, "For the year and a bit", Some(&gif_link()))
}

fn insert_note(
    conn: &Connection,
    id: &str,
    body: &str,
    state: &[u8],
    uid: Option<&str>,
    dirty: i64,
) {
    conn.execute(
        "INSERT INTO notes(id, parent_collection_id, title, body, position,
                           created, modified, trashed_at, yrs_state,
                           etebase_uid, etebase_etag, dirty, payload_schema,
                           favourite, note_kind)
         VALUES (?1, NULL, 'Happy Burpday', ?2, 0, 't', 't', NULL, ?3,
                 ?4, 'etag', ?5, 2, 0, 'markdown')",
        params![id, body, state, uid, dirty],
    )
    .unwrap();
}

fn body_and_dirty(db: &Db, id: &str) -> (String, i64) {
    db.with_conn(|c| {
        Ok(c.query_row(
            "SELECT body, dirty FROM notes WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
    })
    .unwrap()
}

/// What a device would upload for `id`: its row as a payload.
fn payload_from(db: &Db, id: &str) -> NotePayload {
    let (body, state): (String, Vec<u8>) = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT body, yrs_state FROM notes WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    let mut payload = remote_note(id, None, None);
    payload.title = "Happy Burpday".into();
    payload.body = body;
    payload.yrs_state = state;
    payload
}

#[test]
fn second_device_on_a_new_server_does_not_roll_the_body_back() {
    let base = yrs_doc::editor_state_for_tests("Heyo Ichi");
    let desktop_body = format!(
        "Heyo Ichi\n\nFor the year and a bit\n\n![1.00]({})\n",
        gif_link()
    );

    // Desktop logged in first: its rows went up and are clean again.
    let desktop = open_memory_for_tests();
    desktop
        .with_conn(|c| {
            insert_note(
                c,
                "note_ichi",
                &desktop_body,
                &desktop_state(&base),
                Some("uid_new"),
                0,
            );
            Ok(())
        })
        .unwrap();

    // The phone last rendered the note before the GIF went in, and logging
    // into the new server dirtied the row and dropped its uid.
    let phone = open_memory_for_tests();
    phone
        .with_conn(|c| {
            insert_note(c, "note_ichi", "Heyo Ichi\n", &base, None, 1);
            Ok(())
        })
        .unwrap();

    // The phone pulls before it pushes.
    apply_note_payload(
        &phone,
        &payload_from(&desktop, "note_ichi"),
        "uid_new",
        "etag_1",
        None,
        true,
    )
    .unwrap();
    let (phone_body, phone_dirty) = body_and_dirty(&phone, "note_ichi");
    assert_eq!(
        phone_body, desktop_body,
        "the phone had nothing to add, so the desktop's rendering is the merged one"
    );
    assert_eq!(phone_dirty, 1, "the reset still owes the server an upload");

    // The phone's upload comes back to the desktop.
    apply_note_payload(
        &desktop,
        &payload_from(&phone, "note_ichi"),
        "uid_new",
        "etag_2",
        None,
        true,
    )
    .unwrap();
    let (desktop_after, _) = body_and_dirty(&desktop, "note_ichi");
    assert_eq!(
        desktop_after, desktop_body,
        "the desktop keeps its newer text"
    );
    assert!(desktop_after.contains(GIF));
}

#[test]
fn a_dirty_row_with_its_own_edits_keeps_its_rendering() {
    let base = yrs_doc::editor_state_for_tests("Heyo Ichi");
    let phone_state =
        yrs_doc::append_editor_block_for_tests(&base, 202, "typed on the phone", None);

    let phone = open_memory_for_tests();
    phone
        .with_conn(|c| {
            insert_note(
                c,
                "note_ichi",
                "Heyo Ichi\n\ntyped on the phone\n",
                &phone_state,
                Some("uid"),
                1,
            );
            Ok(())
        })
        .unwrap();

    let mut remote = remote_note("note_ichi", None, None);
    remote.body = "Heyo Ichi\n".into();
    remote.yrs_state = base;
    apply_note_payload(&phone, &remote, "uid", "etag_2", None, true).unwrap();

    let (body, dirty) = body_and_dirty(&phone, "note_ichi");
    assert_eq!(
        body, "Heyo Ichi\n\ntyped on the phone\n",
        "the unpushed edit must still go up"
    );
    assert_eq!(dirty, 1);
}

const FULL_BODY: &str = "Heyo Ichi\n\nFor the year and a bit\n";
const STALE_BODY: &str = "Heyo Ichi\n";

/// Both sides hold the same CRDT, rendered once in full and once stale: a
/// device pushed the merged state with a body it could not render.
fn same_state_note(
    db: &Db,
    local_body: &str,
    local_modified: &str,
    remote_body: &str,
) -> NotePayload {
    let state = desktop_state(&yrs_doc::editor_state_for_tests("Heyo Ichi"));
    db.with_conn(|c| {
        insert_note(c, "note_ichi", local_body, &state, Some("uid"), 1);
        c.execute(
            "UPDATE notes SET modified = ?1 WHERE id = 'note_ichi'",
            params![local_modified],
        )?;
        Ok(())
    })
    .unwrap();
    let mut remote = remote_note("note_ichi", None, None);
    remote.body = remote_body.into();
    remote.yrs_state = state;
    remote.modified = Some("2026-05-02T12:00:00Z".into());
    remote
}

#[test]
fn an_editor_repair_of_the_same_state_survives_the_next_pull() {
    // The remote is the newer copy by its stamp, as after a rename there.
    let db = open_memory_for_tests();
    let remote = same_state_note(&db, FULL_BODY, "2026-04-01T08:00:00+00:00", STALE_BODY);
    apply_note_payload(&db, &remote, "uid", "etag_2", None, true).unwrap();

    let (body, dirty) = body_and_dirty(&db, "note_ichi");
    assert_eq!(
        body, FULL_BODY,
        "the full rendering goes up, not the stale one"
    );
    assert_eq!(dirty, 1);
}

#[test]
fn a_stale_local_rendering_takes_the_repaired_remote_one() {
    // The stale side renamed the note after the repair, so its stamp is newer.
    let db = open_memory_for_tests();
    let remote = same_state_note(&db, STALE_BODY, "2026-05-03T08:00:00+00:00", FULL_BODY);
    apply_note_payload(&db, &remote, "uid", "etag_2", None, true).unwrap();

    let (body, _) = body_and_dirty(&db, "note_ichi");
    assert_eq!(body, FULL_BODY);
}

fn insert_asset(conn: &Connection, scope: Option<&str>) {
    conn.execute(
        "INSERT INTO assets(id, owning_note_id, mime_type, bytes, size, created, modified,
                            etebase_uid, etebase_etag, dirty, share_scope_id)
         VALUES (?1, 'note_ichi', 'image/gif', X'474946', 3, 't', 't',
                 'uid_gif', 'etag_gif', 0, ?2)",
        params![GIF, scope],
    )
    .unwrap();
}

fn asset_row(db: &Db) -> Option<(Option<String>, i64)> {
    db.with_conn(|c| {
        Ok(c.query_row(
            "SELECT etebase_uid, dirty FROM assets WHERE id = ?1",
            params![GIF],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
    })
    .unwrap()
}

#[test]
fn a_remote_asset_delete_keeps_an_image_a_note_here_still_shows() {
    let base = yrs_doc::editor_state_for_tests("Heyo Ichi");
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        // The body is the stale rendering; only the CRDT holds the GIF.
        insert_note(
            c,
            "note_ichi",
            "Heyo Ichi\n",
            &desktop_state(&base),
            Some("uid_note"),
            0,
        );
        insert_asset(c, None);
        Ok(())
    })
    .unwrap();

    db.with_conn(|c| apply_remote_delete(c, "assets", "uid_gif", None))
        .unwrap();

    assert_eq!(
        asset_row(&db),
        Some((None, 1)),
        "kept, detached from the deleted item and queued for re-upload"
    );
}

#[test]
fn a_kept_asset_whose_owner_was_deleted_is_uploaded_again() {
    let base = yrs_doc::editor_state_for_tests("Heyo Ichi");
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        // The note that uploaded the GIF, and another one that also shows it.
        insert_note(c, "note_ichi", "", &base, Some("uid_note"), 0);
        insert_note(
            c,
            "note_ni",
            &format!("![]({})", gif_link()),
            &base,
            Some("uid_ni"),
            0,
        );
        insert_asset(c, None);
        Ok(())
    })
    .unwrap();

    // Another device deleted the first note, then the GIF.
    db.with_conn(|c| apply_remote_delete(c, "notes", "uid_note", None))
        .unwrap();
    db.with_conn(|c| apply_remote_delete(c, "assets", "uid_gif", None))
        .unwrap();

    let owner: Option<String> = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT owning_note_id FROM assets WHERE id = ?1",
                params![GIF],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(owner.as_deref(), Some("note_ni"));
    let dirty = load_dirty_assets(&db, None).unwrap();
    assert_eq!(
        dirty.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
        [GIF],
        "the push picks it up again"
    );
}

#[test]
fn a_remote_asset_delete_removes_an_image_no_note_shows_any_more() {
    let base = yrs_doc::editor_state_for_tests("Heyo Ichi");
    let removed = yrs_doc::remove_editor_blocks_for_tests(&desktop_state(&base), 303, &gif_link());
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        insert_note(c, "note_ichi", "Heyo Ichi\n", &removed, Some("uid_note"), 0);
        // An old version in this device's history still shows the image.
        // History is local, so it does not veto a delete.
        c.execute(
            "INSERT INTO note_versions(id, note_id, created, note_kind, body, size)
             VALUES ('ver_1', 'note_ichi', 't', 'markdown', ?1, 1)",
            params![
                mindstream_storage_core::history::compress(&format!("![]({})", gif_link()))
                    .unwrap()
            ],
        )?;
        insert_asset(c, None);
        Ok(())
    })
    .unwrap();

    db.with_conn(|c| apply_remote_delete(c, "assets", "uid_gif", None))
        .unwrap();

    assert_eq!(asset_row(&db), None, "a removed image is deleted as before");
}

#[test]
fn a_reference_from_another_space_does_not_keep_an_asset() {
    let base = yrs_doc::editor_state_for_tests("Heyo Ichi");
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        insert_note(
            c,
            "note_ichi",
            "",
            &desktop_state(&base),
            Some("uid_note"),
            0,
        );
        c.execute(
            "UPDATE notes SET share_scope_id = 'share_a' WHERE id = 'note_ichi'",
            [],
        )?;
        insert_asset(c, None);
        Ok(())
    })
    .unwrap();

    db.with_conn(|c| apply_remote_delete(c, "assets", "uid_gif", None))
        .unwrap();

    assert_eq!(asset_row(&db), None);
}
