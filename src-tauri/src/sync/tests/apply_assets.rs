//! Reference bookkeeping while pulled notes and assets arrive independently.

use super::fixtures::*;
use super::*;

fn remote_asset(id: &str, owner: &str, bytes: &[u8]) -> AssetPayload {
    AssetPayload {
        schema: 2,
        id: id.into(),
        owning_note_id: owner.into(),
        mime_type: "image/png".into(),
        bytes: bytes.to_vec(),
        size: bytes.len() as i64,
        created: "2026-05-01T12:00:00Z".into(),
        modified: "2026-05-02T12:00:00Z".into(),
    }
}

fn note_with_asset(id: &str, asset_id: &str) -> NotePayload {
    let mut note = remote_note(id, None, None);
    note.body = format!("![shared](asset:mindstream/{asset_id})");
    note
}

fn assert_shared_asset_survives_owner_purge(db: &Db, asset_id: &str) {
    db.with_conn(|conn| {
        let refs: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT note_id FROM asset_refs WHERE asset_id = ?1 ORDER BY note_id")?;
            let rows = stmt.query_map(params![asset_id], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        assert_eq!(refs, vec!["note_other", "note_owner"]);

        crate::assets::release_note_assets(conn, "note_owner")?;
        conn.execute("DELETE FROM notes WHERE id = 'note_owner'", [])?;

        let survivor: (i64, Option<String>, i64) = conn.query_row(
            "SELECT COUNT(*), MAX(owning_note_id),
                    (SELECT COUNT(*) FROM asset_refs
                     WHERE asset_id = ?1 AND note_id = 'note_other')
             FROM assets WHERE id = ?1",
            params![asset_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(survivor, (1, Some("note_other".into()), 1));
        Ok(())
    })
    .unwrap();
}

#[test]
fn pulled_asset_registers_all_notes_that_arrived_first() {
    let db = open_memory_for_tests();
    let asset_id = "asset_shared";
    for note_id in ["note_owner", "note_other"] {
        apply_note_payload(
            &db,
            &note_with_asset(note_id, asset_id),
            &format!("uid_{note_id}"),
            "etag_note",
            None,
            true,
        )
        .unwrap();
    }

    let payload = remote_asset(asset_id, "note_owner", &[1, 2, 3]);
    assert!(matches!(
        apply_asset_payload(&db, &payload, "uid_asset", "etag_asset", None).unwrap(),
        ApplyAssetOutcome::Applied(id) if id == asset_id
    ));

    assert_shared_asset_survives_owner_purge(&db, asset_id);
}

#[test]
fn pulled_note_registers_asset_that_arrived_first_and_asset_hash_tracks_bytes() {
    let db = open_memory_for_tests();
    let asset_id = "asset_shared_reverse";
    apply_note_payload(
        &db,
        &note_with_asset("note_owner", asset_id),
        "uid_owner",
        "etag_note",
        None,
        true,
    )
    .unwrap();

    let initial = remote_asset(asset_id, "note_owner", &[4, 5, 6]);
    apply_asset_payload(&db, &initial, "uid_asset", "etag_one", None).unwrap();

    apply_note_payload(
        &db,
        &note_with_asset("note_other", asset_id),
        "uid_other",
        "etag_note",
        None,
        true,
    )
    .unwrap();

    let replacement = remote_asset(asset_id, "note_owner", &[7, 8, 9]);
    apply_asset_payload(&db, &replacement, "uid_asset", "etag_two", None).unwrap();
    let stored_hash: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT content_hash FROM assets WHERE id = ?1",
                params![asset_id],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(stored_hash, crate::assets::content_hash(&[7, 8, 9]));

    assert_shared_asset_survives_owner_purge(&db, asset_id);
}
