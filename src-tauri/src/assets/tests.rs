use super::*;
use crate::db::open_memory_for_tests;
use crate::notes::{create as create_note, update as update_note, CreateNote, UpdateNote};

fn make_note(db: &Db) -> String {
    db.with_conn(|c| {
        create_note(
            c,
            CreateNote {
                title: Some("Drawing".into()),
                body: None,
                parent_collection_id: None,
                note_kind: Some("freeform".into()),
            },
        )
    })
    .unwrap()
    .summary
    .id
}

fn make_markdown_note(db: &Db) -> String {
    db.with_conn(|c| {
        create_note(
            c,
            CreateNote {
                title: Some("Markdown".into()),
                body: Some(String::new()),
                parent_collection_id: None,
                note_kind: Some("markdown".into()),
            },
        )
    })
    .unwrap()
    .summary
    .id
}

#[test]
fn upload_then_fetch_round_trip() {
    let db = open_memory_for_tests();
    let note_id = make_note(&db);
    let bytes = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]; // PNG header
    let asset = db
        .with_conn(|c| {
            upload(
                c,
                UploadAsset {
                    owning_note_id: note_id.clone(),
                    mime_type: "image/png".into(),
                    bytes: bytes.clone(),
                },
            )
        })
        .unwrap();
    assert_eq!(asset.summary.owning_note_id, note_id);
    assert_eq!(asset.summary.mime_type, "image/png");
    assert_eq!(asset.summary.size, bytes.len() as i64);
    assert!(!asset.summary.pushed);
    assert_eq!(asset.bytes, bytes);

    let loaded = db.with_conn(|c| load(c, &asset.summary.id)).unwrap();
    assert_eq!(loaded.bytes, bytes);
}

#[test]
fn upload_rejects_missing_note() {
    let db = open_memory_for_tests();
    let res = db.with_conn(|c| {
        upload(
            c,
            UploadAsset {
                owning_note_id: "note_does_not_exist".into(),
                mime_type: "image/png".into(),
                bytes: vec![1, 2, 3],
            },
        )
    });
    match res {
        Err(AppError::NotFound(_)) => {}
        other => panic!("expected NotFound, got {other:?}"),
    }
}

#[test]
fn purging_owning_note_cascades_to_assets() {
    // The ON DELETE CASCADE on owning_note_id is what cleans up after
    // a freeform note is purged from trash. Sync-tombstone-on-asset
    // is a slice 2b concern; for now we just want the local rows to
    // disappear together.
    let db = open_memory_for_tests();
    let note_id = make_note(&db);
    let asset = db
        .with_conn(|c| {
            upload(
                c,
                UploadAsset {
                    owning_note_id: note_id.clone(),
                    mime_type: "image/png".into(),
                    bytes: vec![1, 2, 3],
                },
            )
        })
        .unwrap();

    db.with_conn(|c| crate::notes::purge(c, &note_id)).unwrap();

    let res = db.with_conn(|c| load(c, &asset.summary.id));
    assert!(res.is_err(), "asset should be gone after owning note purge");
}

#[test]
fn fetch_unknown_id_is_not_found() {
    let db = open_memory_for_tests();
    let res = db.with_conn(|c| load(c, "asset_nope"));
    match res {
        Err(AppError::NotFound(_)) => {}
        other => panic!("expected NotFound, got {other:?}"),
    }
}

#[test]
fn import_pdf_creates_pdf_note_with_separate_asset() {
    let db = open_memory_for_tests();
    let pdf_bytes = b"%PDF-1.7\n%mindstream-test\n".to_vec();
    let note = db
        .with_conn(|c| {
            import_pdf_note_inner(
                c,
                ImportPdfNote {
                    title: Some("Paper".into()),
                    parent_collection_id: None,
                    bytes: pdf_bytes.clone(),
                },
            )
        })
        .unwrap();

    assert_eq!(note.summary.title, "Paper");
    assert_eq!(note.summary.note_kind, "pdf");
    assert!(note.yrs_state.is_empty());
    let pointer: serde_json::Value = serde_json::from_str(&note.body).unwrap();
    let asset_id = pointer["pdfAssetId"].as_str().unwrap();

    let asset = db.with_conn(|c| load(c, asset_id)).unwrap();
    assert_eq!(asset.summary.owning_note_id, note.summary.id);
    assert_eq!(asset.summary.mime_type, "application/pdf");
    assert_eq!(asset.bytes, pdf_bytes);
}

#[test]
fn import_pdf_rejects_empty_bytes() {
    let db = open_memory_for_tests();

    let res = db.with_conn(|c| {
        import_pdf_note_inner(
            c,
            ImportPdfNote {
                title: Some("Empty".into()),
                parent_collection_id: None,
                bytes: vec![],
            },
        )
    });

    let err = res.expect_err("empty PDF import should fail");
    assert!(matches!(
        err,
        AppError::InvalidArg(message) if message.contains("PDF file is empty")
    ));
}

#[test]
fn asset_reference_counts_reads_pdf_asset_id_from_json_body() {
    let db = open_memory_for_tests();
    let note = db
        .with_conn(|c| {
            import_pdf_note_inner(
                c,
                ImportPdfNote {
                    title: Some("Paper".into()),
                    parent_collection_id: None,
                    bytes: b"%PDF-1.7\n%mindstream-test\n".to_vec(),
                },
            )
        })
        .unwrap();

    let pointer: serde_json::Value = serde_json::from_str(&note.body).unwrap();
    let asset_id = pointer["pdfAssetId"].as_str().unwrap();

    let refs = db
        .with_conn(|c| asset_reference_counts(c, &note.summary.id))
        .unwrap();
    assert_eq!(refs.get(asset_id), Some(&1));
}

#[test]
fn purge_unreferenced_markdown_assets_is_noop_for_non_markdown_notes() {
    let db = open_memory_for_tests();
    let note_id = make_note(&db);
    let asset = db
        .with_conn(|c| {
            upload(
                c,
                UploadAsset {
                    owning_note_id: note_id.clone(),
                    mime_type: "image/png".into(),
                    bytes: vec![1, 2, 3],
                },
            )
        })
        .unwrap();

    let removed = db
        .with_conn(|c| purge_unreferenced_markdown_assets(c, &note_id))
        .unwrap();

    assert_eq!(removed, 0);
    assert!(db.with_conn(|c| load(c, &asset.summary.id)).is_ok());
}

#[test]
fn markdown_update_keeps_unreferenced_asset_for_editor_undo() {
    let db = open_memory_for_tests();
    let note_id = make_markdown_note(&db);
    let asset = db
        .with_conn(|c| {
            upload(
                c,
                UploadAsset {
                    owning_note_id: note_id.clone(),
                    mime_type: "image/png".into(),
                    bytes: vec![1, 2, 3],
                },
            )
        })
        .unwrap();

    db.with_conn_mut(|c| {
        update_note(
            c,
            UpdateNote {
                id: note_id.clone(),
                title: None,
                body: Some(format!("![](asset:mindstream/{})", asset.summary.id)),
                parent_collection_id: None,
                position: None,
                tags: None,
                yrs_state: None,
                favourite: None,
            },
        )
    })
    .unwrap();
    db.with_conn_mut(|c| {
        update_note(
            c,
            UpdateNote {
                id: note_id.clone(),
                title: None,
                body: Some("removed".into()),
                parent_collection_id: None,
                position: None,
                tags: None,
                yrs_state: None,
                favourite: None,
            },
        )
    })
    .unwrap();

    let res = db.with_conn(|c| load(c, &asset.summary.id));
    assert!(
        res.is_ok(),
        "normal saves must not delete an asset still reachable from editor undo"
    );
}

#[test]
fn startup_sweep_deletes_unreferenced_asset_without_history_ref() {
    let db = open_memory_for_tests();
    let note_id = make_markdown_note(&db);
    let asset = db
        .with_conn(|c| {
            upload(
                c,
                UploadAsset {
                    owning_note_id: note_id.clone(),
                    mime_type: "image/png".into(),
                    bytes: vec![1, 2, 3],
                },
            )
        })
        .unwrap();

    db.with_conn_mut(|c| {
        update_note(
            c,
            UpdateNote {
                id: note_id.clone(),
                title: None,
                body: Some("removed".into()),
                parent_collection_id: None,
                position: None,
                tags: None,
                yrs_state: None,
                favourite: None,
            },
        )
    })
    .unwrap();

    let removed = db
        .with_conn(|c| sweep_unreferenced_markdown_assets_inner(c))
        .unwrap();

    assert_eq!(removed, 1);
    let res = db.with_conn(|c| load(c, &asset.summary.id));
    assert!(
        res.is_err(),
        "startup sweep deletes assets with no live/history refs"
    );
}

#[test]
fn startup_sweep_is_noop_when_asset_still_referenced() {
    let db = open_memory_for_tests();
    let note_id = make_markdown_note(&db);
    let asset = db
        .with_conn(|c| {
            upload(
                c,
                UploadAsset {
                    owning_note_id: note_id.clone(),
                    mime_type: "image/png".into(),
                    bytes: vec![1, 2, 3],
                },
            )
        })
        .unwrap();
    let body = format!("![](asset:mindstream/{})", asset.summary.id);

    db.with_conn_mut(|c| {
        update_note(
            c,
            UpdateNote {
                id: note_id.clone(),
                title: None,
                body: Some(body),
                parent_collection_id: None,
                position: None,
                tags: None,
                yrs_state: None,
                favourite: None,
            },
        )
    })
    .unwrap();

    let removed = db
        .with_conn(|c| sweep_unreferenced_markdown_assets_inner(c))
        .unwrap();

    assert_eq!(
        removed, 0,
        "a still-referenced asset must survive the sweep"
    );
    let res = db.with_conn(|c| load(c, &asset.summary.id));
    assert!(res.is_ok(), "referenced asset must not be deleted");
}

#[test]
fn startup_sweep_aggregates_across_multiple_markdown_notes() {
    let db = open_memory_for_tests();

    // Two independent markdown notes, each with its own orphaned asset,
    // so the sweep has to iterate every note and sum the removals.
    let mut assets = Vec::new();
    for _ in 0..2 {
        let note_id = make_markdown_note(&db);
        let asset = db
            .with_conn(|c| {
                upload(
                    c,
                    UploadAsset {
                        owning_note_id: note_id.clone(),
                        mime_type: "image/png".into(),
                        bytes: vec![1, 2, 3],
                    },
                )
            })
            .unwrap();
        db.with_conn_mut(|c| {
            update_note(
                c,
                UpdateNote {
                    id: note_id.clone(),
                    title: None,
                    body: Some("removed".into()),
                    parent_collection_id: None,
                    position: None,
                    tags: None,
                    yrs_state: None,
                    favourite: None,
                },
            )
        })
        .unwrap();
        assets.push(asset.summary.id);
    }

    let removed = db
        .with_conn(|c| sweep_unreferenced_markdown_assets_inner(c))
        .unwrap();

    assert_eq!(removed, 2, "sweep should sum removals across all notes");
    for id in assets {
        assert!(
            db.with_conn(|c| load(c, &id)).is_err(),
            "each note's orphaned asset should be gone"
        );
    }
}

#[test]
fn markdown_cleanup_keeps_history_referenced_asset_until_history_pruned() {
    let db = open_memory_for_tests();
    let note_id = make_markdown_note(&db);
    let asset = db
        .with_conn(|c| {
            upload(
                c,
                UploadAsset {
                    owning_note_id: note_id.clone(),
                    mime_type: "image/png".into(),
                    bytes: vec![1, 2, 3],
                },
            )
        })
        .unwrap();
    let body = format!("![](asset:mindstream/{})", asset.summary.id);
    let version = db
        .with_conn(|c| crate::history::capture(c, &note_id, "markdown", "edited", None, &body))
        .unwrap()
        .unwrap();

    db.with_conn_mut(|c| {
        update_note(
            c,
            UpdateNote {
                id: note_id.clone(),
                title: None,
                body: Some("removed".into()),
                parent_collection_id: None,
                position: None,
                tags: None,
                yrs_state: None,
                favourite: None,
            },
        )
    })
    .unwrap();
    assert!(
        db.with_conn(|c| load(c, &asset.summary.id)).is_ok(),
        "history snapshot keeps the asset alive"
    );

    let old = (Utc::now() - chrono::Duration::days(100)).to_rfc3339();
    db.with_conn(|c| {
        c.execute(
            "UPDATE note_versions SET created = ?2 WHERE id = ?1",
            params![version.id, old],
        )?;
        Ok(())
    })
    .unwrap();
    db.with_conn(|c| crate::history::prune(c, Some(90)))
        .unwrap();
    db.with_conn(|c| sweep_unreferenced_markdown_assets_inner(c))
        .unwrap();

    let res = db.with_conn(|c| load(c, &asset.summary.id));
    assert!(
        res.is_err(),
        "asset is deleted once the last history reference is pruned"
    );
}

#[test]
fn upload_inherits_owning_note_share_scope() {
    let db = open_memory_for_tests();
    let note_id = make_markdown_note(&db);
    // Put the note into a share scope, as create-time inheritance would.
    db.with_conn(|c| {
        c.execute(
            "UPDATE notes SET share_scope_id = 'scope_1' WHERE id = ?1",
            params![note_id],
        )?;
        Ok::<(), AppError>(())
    })
    .unwrap();

    let asset = db
        .with_conn(|c| {
            upload(
                c,
                UploadAsset {
                    owning_note_id: note_id.clone(),
                    mime_type: "image/png".into(),
                    bytes: vec![0x00],
                },
            )
        })
        .unwrap();

    let scope: Option<String> = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT share_scope_id FROM assets WHERE id = ?1",
                params![asset.summary.id],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(scope.as_deref(), Some("scope_1"));
}
