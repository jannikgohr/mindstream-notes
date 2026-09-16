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
    assert_eq!(asset.summary.owning_note_id, Some(note_id));
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
fn purging_owning_note_frees_its_unshared_assets() {
    // Purging a freeform note still reclaims its blobs — but via
    // release_note_assets counting references, not the ON DELETE CASCADE
    // that used to sit on owning_note_id. The observable result for a note
    // whose asset nothing else references is unchanged.
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
    assert_eq!(asset.summary.owning_note_id, Some(note.summary.id));
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
        .with_conn(sweep_unreferenced_markdown_assets_inner)
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
        .with_conn(sweep_unreferenced_markdown_assets_inner)
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
    //
    // The bytes differ per note on purpose: uploads are content-addressed, so
    // identical payloads would dedup into ONE asset referenced twice and the
    // sweep would (correctly) report a single removal — which would no longer
    // exercise the summing this test is about.
    let mut assets = Vec::new();
    for i in 0..2u8 {
        let note_id = make_markdown_note(&db);
        let asset = db
            .with_conn(|c| {
                upload(
                    c,
                    UploadAsset {
                        owning_note_id: note_id.clone(),
                        mime_type: "image/png".into(),
                        bytes: vec![1, 2, 3, i],
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
        .with_conn(sweep_unreferenced_markdown_assets_inner)
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
    db.with_conn(sweep_unreferenced_markdown_assets_inner)
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

// ---------- reference counting ----------

#[test]
fn an_asset_referenced_by_two_notes_survives_purging_one() {
    // The bug this whole design exists for. Before asset_refs, the second
    // note's image died with the first note: owning_note_id cascaded the row
    // away, and the sweep only ever looked inside the *owning* note's body.
    let db = open_memory_for_tests();
    let first = make_markdown_note(&db);
    let second = make_markdown_note(&db);

    let asset_id = db
        .with_conn(|c| store_deduped(c, &first, "image/png", &[1, 2, 3]))
        .unwrap()
        .id;
    let body = format!("![pic](asset:mindstream/{asset_id})");
    for note in [&first, &second] {
        db.with_conn_mut(|c| {
            update_note(
                c,
                UpdateNote {
                    id: note.clone(),
                    title: None,
                    body: Some(body.clone()),
                    parent_collection_id: None,
                    position: None,
                    tags: None,
                    yrs_state: None,
                    favourite: None,
                },
            )
        })
        .unwrap();
    }

    db.with_conn(|c| crate::notes::purge(c, &first)).unwrap();

    assert!(
        db.with_conn(|c| load(c, &asset_id)).is_ok(),
        "the surviving note still references this asset"
    );
    // And a sweep must not finish the job either — the second note's body
    // still points at it.
    db.with_conn(sweep_unreferenced_markdown_assets_inner)
        .unwrap();
    assert!(
        db.with_conn(|c| load(c, &asset_id)).is_ok(),
        "a referenced asset must survive the reconciliation sweep"
    );
}

#[test]
fn purging_the_last_referencing_note_frees_the_asset() {
    let db = open_memory_for_tests();
    let first = make_markdown_note(&db);
    let second = make_markdown_note(&db);
    let asset_id = db
        .with_conn(|c| store_deduped(c, &first, "image/png", &[9, 9, 9]))
        .unwrap()
        .id;
    db.with_conn(|c| add_ref(c, &asset_id, &second)).unwrap();

    db.with_conn(|c| crate::notes::purge(c, &first)).unwrap();
    assert!(db.with_conn(|c| load(c, &asset_id)).is_ok());

    db.with_conn(|c| crate::notes::purge(c, &second)).unwrap();
    assert!(
        db.with_conn(|c| load(c, &asset_id)).is_err(),
        "nothing references it any more, so the bytes go"
    );
}

#[test]
fn purging_the_creator_re_anchors_a_still_referenced_asset() {
    // owning_note_id rides the sync wire and DirtyAsset requires it, so an
    // asset that outlives its creator has to be re-pointed at a live referrer
    // rather than left dangling.
    let db = open_memory_for_tests();
    let creator = make_markdown_note(&db);
    let other = make_markdown_note(&db);
    let asset_id = db
        .with_conn(|c| store_deduped(c, &creator, "image/png", &[4, 5, 6]))
        .unwrap()
        .id;
    db.with_conn(|c| add_ref(c, &asset_id, &other)).unwrap();

    db.with_conn(|c| crate::notes::purge(c, &creator)).unwrap();

    let owner: Option<String> = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT owning_note_id FROM assets WHERE id = ?1",
                params![asset_id],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(owner, Some(other), "re-anchored to the surviving referrer");
}

#[test]
fn a_pushed_asset_is_tombstoned_when_its_last_reference_goes() {
    let db = open_memory_for_tests();
    let note_id = make_markdown_note(&db);
    let asset_id = db
        .with_conn(|c| store_deduped(c, &note_id, "image/png", &[7]))
        .unwrap()
        .id;
    db.with_conn(|c| {
        c.execute(
            "UPDATE assets SET etebase_uid = 'remote-uid' WHERE id = ?1",
            params![asset_id],
        )?;
        Ok::<(), AppError>(())
    })
    .unwrap();

    db.with_conn(|c| crate::notes::purge(c, &note_id)).unwrap();

    let tombstoned: i64 = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM tombstones WHERE etebase_uid = 'remote-uid'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(tombstoned, 1, "the server copy needs deleting too");
}

// ---------- deduplication ----------

#[test]
fn identical_bytes_in_one_scope_store_a_single_blob() {
    let db = open_memory_for_tests();
    let first = make_markdown_note(&db);
    let second = make_markdown_note(&db);

    let a = db
        .with_conn(|c| store_deduped(c, &first, "image/png", &[1, 1, 2, 3, 5]))
        .unwrap();
    let b = db
        .with_conn(|c| store_deduped(c, &second, "image/png", &[1, 1, 2, 3, 5]))
        .unwrap();

    assert!(!a.deduplicated, "first store writes the blob");
    assert!(b.deduplicated, "second store reuses it");
    let a = a.id;
    let b = b.id;
    assert_eq!(a, b, "same bytes in the same scope reuse one row");
    let rows: i64 = db
        .with_conn(|c| Ok(c.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(rows, 1);
    let refs: i64 = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM asset_refs WHERE asset_id = ?1",
                params![a],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(refs, 2, "one blob, one reference per note");
}

#[test]
fn identical_bytes_in_different_scopes_are_not_shared() {
    // Reusing across scopes would pull a vault-local blob into a shared
    // collection and push it to that scope's recipients. Storing it twice is
    // the cost of not crossing an E2EE boundary.
    let db = open_memory_for_tests();
    let vault_note = make_markdown_note(&db);
    let shared_note = make_markdown_note(&db);
    db.with_conn(|c| {
        c.execute(
            "UPDATE notes SET share_scope_id = 'scope_1' WHERE id = ?1",
            params![shared_note],
        )?;
        Ok::<(), AppError>(())
    })
    .unwrap();

    let a = db
        .with_conn(|c| store_deduped(c, &vault_note, "image/png", &[42]))
        .unwrap()
        .id;
    let b = db
        .with_conn(|c| store_deduped(c, &shared_note, "image/png", &[42]))
        .unwrap();

    assert!(!b.deduplicated, "a different scope must store its own copy");
    let b = b.id;
    assert_ne!(a, b, "scopes must not share a blob");
    let scope: Option<String> = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT share_scope_id FROM assets WHERE id = ?1",
                params![b],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(scope.as_deref(), Some("scope_1"));
}

#[test]
fn upload_with_id_honours_the_requested_id() {
    // import_pdf_note_inner writes {"pdfAssetId": …} into the body before the
    // bytes land, so this path must never hand back a deduped id.
    let db = open_memory_for_tests();
    let first = make_markdown_note(&db);
    let second = make_markdown_note(&db);
    db.with_conn(|c| store_deduped(c, &first, "application/pdf", &[37]))
        .unwrap();

    let asset = db
        .with_conn(|c| {
            upload_with_id(
                c,
                "asset_fixed".into(),
                UploadAsset {
                    owning_note_id: second.clone(),
                    mime_type: "application/pdf".into(),
                    bytes: vec![37],
                },
            )
        })
        .unwrap();

    assert_eq!(asset.summary.id, "asset_fixed");
}

// ---------- drawing assets keep their immunity ----------

#[test]
fn the_sweep_never_frees_a_freeform_notes_asset() {
    // A freeform note references its assets from yrs_state, which the sweep
    // cannot read. Its upload-time reference row is the only thing keeping
    // the blob alive, so reconciliation must leave non-markdown notes alone.
    let db = open_memory_for_tests();
    let note_id = make_note(&db);
    let asset_id = db
        .with_conn(|c| store_deduped(c, &note_id, "image/png", &[1, 2, 3, 4]))
        .unwrap()
        .id;

    let removed = db
        .with_conn(sweep_unreferenced_markdown_assets_inner)
        .unwrap();

    assert_eq!(removed, 0);
    assert!(
        db.with_conn(|c| load(c, &asset_id)).is_ok(),
        "a drawing's asset is not referenced from any body and must survive"
    );
}

#[test]
fn the_sweep_collects_assets_orphaned_by_a_folder_delete() {
    // Deleting a folder cascades its notes away in SQL, which never runs
    // release_note_assets — the FK just nulls owning_note_id. Nothing
    // note-keyed would ever revisit those rows, so the sweep has a dedicated
    // orphan pass.
    let db = open_memory_for_tests();
    let folder = db
        .with_conn(|c| {
            crate::collections::create(
                c,
                crate::collections::CreateCollection {
                    name: "Folder".into(),
                    parent_collection_id: None,
                },
            )
        })
        .unwrap()
        .id;
    let note_id = db
        .with_conn(|c| {
            create_note(
                c,
                CreateNote {
                    title: Some("Drawing".into()),
                    body: None,
                    parent_collection_id: Some(folder.clone()),
                    note_kind: Some("freeform".into()),
                },
            )
        })
        .unwrap()
        .summary
        .id;
    let asset_id = db
        .with_conn(|c| store_deduped(c, &note_id, "image/png", &[8, 8]))
        .unwrap()
        .id;

    db.with_conn(|c| crate::collections::delete(c, &folder))
        .unwrap();

    let removed = db
        .with_conn(sweep_unreferenced_markdown_assets_inner)
        .unwrap();
    assert_eq!(removed, 1);
    assert!(db.with_conn(|c| load(c, &asset_id)).is_err());
}

// ---------- migration 25 backfill ----------

#[test]
fn backfill_hashes_rows_that_predate_content_addressing() {
    let db = open_memory_for_tests();
    let note_id = make_markdown_note(&db);
    let asset_id = db
        .with_conn(|c| store_deduped(c, &note_id, "image/png", &[3, 1, 4]))
        .unwrap()
        .id;
    // Simulate a row written before migration 25.
    db.with_conn(|c| {
        c.execute(
            "UPDATE assets SET content_hash = NULL WHERE id = ?1",
            params![asset_id],
        )?;
        Ok::<(), AppError>(())
    })
    .unwrap();

    let hashed = db.with_conn(backfill_content_hashes).unwrap();
    assert_eq!(hashed, 1);

    let stored: Option<String> = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT content_hash FROM assets WHERE id = ?1",
                params![asset_id],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(stored.as_deref(), Some(content_hash(&[3, 1, 4]).as_str()));

    // Second run has nothing left to do.
    assert_eq!(db.with_conn(backfill_content_hashes).unwrap(), 0);
}

#[test]
fn stale_save_after_scope_move_uses_remap_after_original_blob_is_purged() {
    let db = open_memory_for_tests();
    let moving = make_markdown_note(&db);
    let staying = make_markdown_note(&db);
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO collections(id, name, position, created, modified, share_scope_id)
             VALUES ('shared_folder', 'Shared', 0, 't', 't', 'scope_x')",
            [],
        )?;
        Ok::<(), AppError>(())
    })
    .unwrap();
    let old_id = db
        .with_conn(|c| store_deduped(c, &moving, "image/png", b"shared bytes"))
        .unwrap()
        .id;
    db.with_conn(|c| add_ref(c, &old_id, &staying)).unwrap();
    let stale_body = format!("![old](asset:mindstream/{old_id})");
    let stale_state = crate::sync::yrs_doc::init_with_markdown(&stale_body);

    db.with_conn_mut(|c| {
        update_note(
            c,
            UpdateNote {
                id: moving.clone(),
                title: None,
                body: Some(stale_body.clone()),
                parent_collection_id: Some(Some("shared_folder".into())),
                position: None,
                tags: None,
                yrs_state: Some(stale_state.clone()),
                favourite: None,
            },
        )
    })
    .unwrap();

    let new_id: String = db
        .with_conn(|c| {
            Ok(c.query_row(
                "SELECT new_asset_id FROM asset_id_remaps
                  WHERE note_id = ?1 AND old_asset_id = ?2",
                params![moving, old_id],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_ne!(new_id, old_id);

    db.with_conn(|c| crate::notes::purge(c, &staying)).unwrap();
    assert!(db.with_conn(|c| load(c, &old_id)).is_err());

    db.with_conn_mut(|c| {
        update_note(
            c,
            UpdateNote {
                id: moving.clone(),
                title: None,
                body: Some(stale_body.clone()),
                parent_collection_id: None,
                position: None,
                tags: None,
                yrs_state: Some(stale_state.clone()),
                favourite: None,
            },
        )
    })
    .unwrap();

    let saved = db.with_conn(|c| crate::notes::load(c, &moving)).unwrap();
    assert!(saved.body.contains(&new_id));
    assert!(!saved.body.contains(&old_id));
    let saved_markdown = crate::sync::yrs_doc::to_markdown(&saved.yrs_state);
    assert!(saved_markdown.contains(&new_id));
    assert!(!saved_markdown.contains(&old_id));
    assert!(db.with_conn(|c| load(c, &new_id)).is_ok());
}
