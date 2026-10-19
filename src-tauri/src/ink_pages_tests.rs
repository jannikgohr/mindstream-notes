use std::collections::HashMap;
use std::sync::Arc;

use rusqlite::params;
use yrs::{Any, Doc, Map, ReadTxn, StateVector, Transact};

use crate::{assets, db::open_memory_for_tests, notes, pdf_text, sync::yrs_doc};

fn pages_state(asset_id: &str) -> Vec<u8> {
    let doc = Doc::new();
    let pages = doc.get_or_insert_map("ink:pages");
    let order = doc.get_or_insert_map("ink:pageOrder");
    let deleted = doc.get_or_insert_map("ink:deletedPages");
    {
        let mut txn = doc.transact_mut();
        let background = Any::Map(Arc::new(HashMap::from([
            ("assetId".into(), Any::String(asset_id.into())),
            ("pageIndex".into(), Any::Number(4.0)),
        ])));
        pages.insert(
            &mut txn,
            "page_a",
            Any::Map(Arc::new(HashMap::from([
                ("id".into(), Any::String("page_a".into())),
                ("width".into(), Any::Number(1684.0)),
                ("height".into(), Any::Number(1190.0)),
                ("background".into(), background),
            ]))),
        );
        order.insert(&mut txn, "page_a", 0.0);
        deleted.insert(&mut txn, "page_a", false);
    }
    let txn = doc.transact();
    txn.encode_state_as_update_v1(&StateVector::default())
}

fn create_ink(conn: &rusqlite::Connection) -> String {
    notes::create(
        conn,
        notes::CreateNote {
            title: Some("Ink PDF".into()),
            body: None,
            parent_collection_id: None,
            note_kind: Some(notes::NoteKind::Ink),
        },
    )
    .unwrap()
    .summary
    .id
}

#[test]
fn image_backgrounds_retain_and_remap_both_image_and_thumbnail_assets() {
    let state = pages_state("asset_image");
    let doc = Doc::new();
    yrs::updates::decoder::Decode::decode_v1(&state)
        .map(|update| doc.transact_mut().apply_update(update).unwrap())
        .unwrap();
    let pages = doc.get_or_insert_map("ink:pages");
    {
        let mut txn = doc.transact_mut();
        pages.insert(
            &mut txn,
            "page_a",
            Any::Map(Arc::new(HashMap::from([
                ("id".into(), Any::String("page_a".into())),
                ("width".into(), Any::Number(1684.0)),
                ("height".into(), Any::Number(1190.0)),
                (
                    "background".into(),
                    Any::Map(Arc::new(HashMap::from([
                        ("kind".into(), Any::String("image".into())),
                        ("assetId".into(), Any::String("asset_image".into())),
                        ("thumbnailAssetId".into(), Any::String("asset_thumb".into())),
                        ("pageIndex".into(), Any::Number(4.0)),
                        (
                            "text".into(),
                            Any::String("persisted searchable mango".into()),
                        ),
                    ]))),
                ),
            ]))),
        );
    }
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    assert_eq!(
        yrs_doc::ink_asset_ids(&state),
        ["asset_image", "asset_thumb"]
    );
    let rewritten = yrs_doc::replace_asset_id(&state, "asset_thumb", "asset_preview_new");
    assert_eq!(
        yrs_doc::ink_asset_ids(&rewritten),
        ["asset_image", "asset_preview_new"]
    );
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        let owner = create_ink(c);
        for id in ["asset_image", "asset_thumb"] {
            assets::upload_with_id(
                c,
                id.into(),
                assets::UploadAsset {
                    owning_note_id: owner.clone(),
                    mime_type: "image/jpeg".into(),
                    bytes: vec![255, 216, 255],
                },
            )?;
        }
        let note = assets::import_ink_pdf_note_inner(
            c,
            assets::ImportInkPdfNote {
                title: None,
                parent_collection_id: None,
                bytes: vec![],
                asset_id: "asset_image".into(),
                yrs_state: state,
            },
        )?;
        notes::purge(c, &owner)?;
        for id in ["asset_image", "asset_thumb"] {
            assets::load(c, id)?;
        }
        let signature = yrs_doc::ink_background_signature(&note.yrs_state);
        pdf_text::store_ink_text(
            c,
            &note.summary.id,
            "persisted searchable mango",
            &signature,
        )?;
        Ok(())
    })
    .unwrap();
}

#[test]
fn ink_pages_sign_visible_sources_and_remap_asset_ids() {
    let state = pages_state("asset_old");
    assert_eq!(yrs_doc::ink_asset_ids(&state), ["asset_old"]);
    assert_eq!(
        yrs_doc::ink_background_signature(&state),
        r#"[["page_a","asset_old",4]]"#
    );
    let rewritten = yrs_doc::replace_asset_id(&state, "asset_old", "asset_new");
    assert_eq!(yrs_doc::ink_asset_ids(&rewritten), ["asset_new"]);
    assert_eq!(
        yrs_doc::ink_background_signature(&rewritten),
        r#"[["page_a","asset_new",4]]"#
    );
}

#[test]
fn ink_background_survives_source_note_deletion_and_late_save_remaps() {
    let db = open_memory_for_tests();
    let (source, ink, asset_id) = db
        .with_conn(|c| {
            let source = create_ink(c);
            let ink = create_ink(c);
            let asset = assets::upload(
                c,
                assets::UploadAsset {
                    owning_note_id: source.clone(),
                    mime_type: "application/pdf".into(),
                    bytes: vec![37, 80, 68, 70],
                },
            )?;
            Ok((source, ink, asset.summary.id))
        })
        .unwrap();
    let state = pages_state(&asset_id);
    db.with_conn_mut(|c| notes::save_yrs_state(c, &ink, &state))
        .unwrap();
    db.with_conn(|c| {
        notes::purge(c, &source)?;
        assets::load(c, &asset_id)
    })
    .unwrap();
    db.with_conn(|c| {
        assets::upload_with_id(c, "asset_remapped".into(), assets::UploadAsset { owning_note_id: ink.clone(), mime_type: "application/pdf".into(), bytes: vec![9] })?;
        c.execute("INSERT INTO asset_id_remaps(note_id, old_asset_id, new_asset_id) VALUES (?1, ?2, 'asset_remapped')", params![ink, asset_id])?;
        Ok(())
    }).unwrap();
    db.with_conn_mut(|c| notes::save_yrs_state(c, &ink, &state))
        .unwrap();
    let saved = db.with_conn(|c| notes::load(c, &ink)).unwrap();
    assert_eq!(yrs_doc::ink_asset_ids(&saved.yrs_state), ["asset_remapped"]);
}

#[test]
fn ink_search_rejects_stale_extraction_and_updates_fts_without_dirtying() {
    let db = open_memory_for_tests();
    let ink = db.with_conn(|c| Ok(create_ink(c))).unwrap();
    let state = pages_state("asset_pdf");
    db.with_conn_mut(|c| notes::save_yrs_state(c, &ink, &state))
        .unwrap();
    let signature = yrs_doc::ink_background_signature(&state);
    db.with_conn(|c| {
        c.execute("UPDATE notes SET dirty = 0 WHERE id = ?1", params![ink])?;
        pdf_text::store_ink_text(c, &ink, "searchable mango", "[]")?;
        let text: Option<String> = c.query_row(
            "SELECT pdf_text FROM notes WHERE id = ?1",
            params![ink],
            |r| r.get(0),
        )?;
        assert!(text.is_none());
        pdf_text::store_ink_text(c, &ink, "searchable mango", &signature)?;
        let count: i64 = c.query_row(
            "SELECT COUNT(*) FROM note_search WHERE note_search MATCH 'mango'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(count, 1);
        let dirty: i64 =
            c.query_row("SELECT dirty FROM notes WHERE id = ?1", params![ink], |r| {
                r.get(0)
            })?;
        assert_eq!(dirty, 0);
        Ok(())
    })
    .unwrap();
    // A new background signature invalidates both cached content and FTS candidates.
    let changed = yrs_doc::replace_asset_id(&state, "asset_pdf", "asset_other");
    db.with_conn_mut(|c| notes::save_yrs_state(c, &ink, &changed))
        .unwrap();
    db.with_conn(|c| {
        let count: i64 = c.query_row(
            "SELECT COUNT(*) FROM note_search WHERE note_search MATCH 'mango'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(count, 0);
        Ok(())
    })
    .unwrap();
}

#[test]
fn ink_conversion_is_atomic_when_asset_insertion_fails() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        let owner = create_ink(c);
        assets::upload_with_id(
            c,
            "asset_collision".into(),
            assets::UploadAsset {
                owning_note_id: owner,
                mime_type: "application/pdf".into(),
                bytes: vec![1],
            },
        )?;
        let before: i64 = c.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))?;
        let result = assets::import_ink_pdf_note_inner(
            c,
            assets::ImportInkPdfNote {
                title: None,
                parent_collection_id: None,
                bytes: vec![2],
                asset_id: "asset_collision".into(),
                yrs_state: pages_state("asset_collision"),
            },
        );
        assert!(result.is_err());
        let after: i64 = c.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))?;
        assert_eq!(before, after);
        Ok(())
    })
    .unwrap();
}

#[test]
fn ink_conversion_reuses_pdf_blob_and_retains_it_after_source_purge() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        let source = assets::import_pdf_note_inner(
            c,
            assets::ImportPdfNote {
                title: Some("Original PDF".into()),
                parent_collection_id: None,
                bytes: vec![37, 80, 68, 70],
            },
        )?;
        let body: serde_json::Value = serde_json::from_str(&source.body).unwrap();
        let asset_id = body["pdfAssetId"].as_str().unwrap().to_owned();
        let ink = assets::import_ink_pdf_note_inner(
            c,
            assets::ImportInkPdfNote {
                title: Some("Converted".into()),
                parent_collection_id: None,
                bytes: vec![],
                asset_id: asset_id.clone(),
                yrs_state: pages_state(&asset_id),
            },
        )?;
        assert_eq!(ink.summary.note_kind, notes::NoteKind::Ink);
        let blobs: i64 = c.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))?;
        assert_eq!(blobs, 1);
        notes::load(c, &source.summary.id)?;
        notes::purge(c, &source.summary.id)?;
        assert_eq!(assets::load(c, &asset_id)?.bytes, [37, 80, 68, 70]);
        assert_eq!(
            yrs_doc::ink_asset_ids(&notes::load(c, &ink.summary.id)?.yrs_state),
            [asset_id]
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn ink_conversion_rejects_a_pdf_from_another_share_scope_atomically() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        let owner = create_ink(c);
        let asset = assets::upload(
            c,
            assets::UploadAsset {
                owning_note_id: owner,
                mime_type: "application/pdf".into(),
                bytes: vec![37, 80, 68, 70],
            },
        )?;
        c.execute(
            "UPDATE assets SET share_scope_id = 'other_scope' WHERE id = ?1",
            params![asset.summary.id],
        )?;
        let before: i64 = c.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))?;
        assert!(assets::import_ink_pdf_note_inner(
            c,
            assets::ImportInkPdfNote {
                title: None,
                parent_collection_id: None,
                bytes: vec![],
                asset_id: asset.summary.id.clone(),
                yrs_state: pages_state(&asset.summary.id),
            }
        )
        .is_err());
        let after: i64 = c.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))?;
        assert_eq!(before, after);
        Ok(())
    })
    .unwrap();
}
