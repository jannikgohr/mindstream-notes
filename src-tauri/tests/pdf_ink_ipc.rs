//! Exercise binary PDF/image transport and text indexing through Tauri IPC.
//! The mock runtime uses an isolated in-memory database and never opens a native window.
use mindstream_notes_lib::db::Db;
use mindstream_notes_lib::notes::Note;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::ipc::InvokeBody;
use tauri::ipc::InvokeResponseBody;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::Manager;
use yrs::{Any, Doc, Map, ReadTxn, StateVector, Transact};

fn fixture() -> (tauri::App<MockRuntime>, tauri::WebviewWindow<MockRuntime>) {
    let app = mock_builder()
        .manage(Db::open(std::path::Path::new(":memory:")).unwrap())
        .manage(mindstream_notes_lib::vault_jobs::Saves::default())
        .invoke_handler(tauri::generate_handler![
            mindstream_notes_lib::assets::binary::upload_asset_bytes,
            mindstream_notes_lib::assets::binary::import_pdf_note_bytes,
            mindstream_notes_lib::assets::binary::fetch_asset_bytes,
            mindstream_notes_lib::assets::import_ink_pdf_note,
            mindstream_notes_lib::pdf_text::pdf_page_text,
            mindstream_notes_lib::pdf_text::set_pdf_text,
            mindstream_notes_lib::pdf_text::pdf_notes_missing_text,
            mindstream_notes_lib::pdf_text::pdf_note_needs_text,
        ])
        .build(mock_context(noop_assets()))
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "test", Default::default())
        .build()
        .unwrap();
    (app, view)
}

fn call(
    view: &tauri::WebviewWindow<MockRuntime>,
    command: &str,
    body: InvokeBody,
) -> Result<InvokeResponseBody, Value> {
    tauri::test::get_ipc_response(
        view,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: if cfg!(any(windows, target_os = "android")) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body,
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
}

fn payload(metadata: Value, bytes: &[u8]) -> Vec<u8> {
    let metadata = serde_json::to_vec(&metadata).unwrap();
    let mut payload = (metadata.len() as u32).to_le_bytes().to_vec();
    payload.extend(metadata);
    payload.extend(bytes);
    payload
}

fn imported(view: &tauri::WebviewWindow<MockRuntime>, mobile: bool) -> Note {
    let payload = payload(
        json!({"title": "Grüße", "parent_collection_id": null}),
        &[0, 37, 80, 68, 70, 255],
    );
    let body = if mobile {
        InvokeBody::Json(json!(payload))
    } else {
        InvokeBody::Raw(payload)
    };
    call(view, "import_pdf_note_bytes", body)
        .unwrap()
        .deserialize()
        .unwrap()
}

/// One PDF-backed ink page, encoded the way the editor sends it.
fn ink_pages(asset_id: &str) -> Vec<u8> {
    let doc = Doc::new();
    let pages = doc.get_or_insert_map("ink:pages");
    {
        let mut txn = doc.transact_mut();
        let background = Any::Map(Arc::new(HashMap::from([
            ("assetId".to_string(), Any::String(asset_id.into())),
            ("pageIndex".to_string(), Any::Number(0.0)),
        ])));
        let page = Any::Map(Arc::new(HashMap::from([
            ("id".to_string(), Any::String("page_a".into())),
            ("background".to_string(), background),
        ])));
        pages.insert(&mut txn, "page_a", page);
    }
    let txn = doc.transact();
    txn.encode_state_as_update_v1(&StateVector::default())
}

#[test]
fn binary_commands_round_trip_desktop_and_android_payloads_without_echoing_uploads() {
    for mobile in [false, true] {
        let (_app, view) = fixture();
        let note = imported(&view, mobile);
        assert_eq!(note.summary.title, "Grüße");
        assert_eq!(note.summary.note_kind.as_str(), "pdf");
        let payload = payload(
            json!({"owning_note_id": note.summary.id, "mime_type": "image/jpeg"}),
            &[0, 255, 1, 2, 3],
        );
        let body = if mobile {
            InvokeBody::Json(json!(payload))
        } else {
            InvokeBody::Raw(payload)
        };
        let response: Value = call(&view, "upload_asset_bytes", body.clone())
            .unwrap()
            .deserialize()
            .unwrap();
        assert_eq!(response["size"], 5);
        assert_eq!(response["mime_type"], "image/jpeg");
        assert!(response.get("bytes").is_none());
        let repeated: Value = call(&view, "upload_asset_bytes", body)
            .unwrap()
            .deserialize()
            .unwrap();
        assert_eq!(response["id"], repeated["id"]);
        let reply = call(
            &view,
            "fetch_asset_bytes",
            InvokeBody::Json(json!({"id": response["id"], "mimeType": "image/jpeg"})),
        )
        .unwrap();
        assert!(matches!(&reply, InvokeResponseBody::Raw(_)));
        assert_eq!(reply.deserialize::<Vec<u8>>().unwrap(), [0, 255, 1, 2, 3]);
        let unchecked = call(
            &view,
            "fetch_asset_bytes",
            InvokeBody::Json(json!({"id": response["id"]})),
        )
        .unwrap();
        assert_eq!(unchecked.deserialize::<Vec<u8>>().unwrap().len(), 5);
        assert!(call(
            &view,
            "fetch_asset_bytes",
            InvokeBody::Json(json!({"id": response["id"], "mimeType": "application/pdf"}))
        )
        .is_err());
        assert!(call(
            &view,
            "fetch_asset_bytes",
            InvokeBody::Json(json!({"id": "missing"}))
        )
        .is_err());
    }
}

#[test]
fn binary_commands_reject_bad_frames_empty_pdfs_and_writes_during_shutdown() {
    let (app, view) = fixture();
    for body in [
        InvokeBody::Raw(vec![]),
        InvokeBody::Json(json!({"bad": true})),
        InvokeBody::Raw(vec![1, 0, 0, 0, b'{']),
    ] {
        assert!(call(&view, "import_pdf_note_bytes", body.clone()).is_err());
        assert!(call(&view, "upload_asset_bytes", body).is_err());
    }
    assert!(call(
        &view,
        "import_pdf_note_bytes",
        InvokeBody::Raw(payload(json!({}), &[]))
    )
    .is_err());
    let note = imported(&view, false);
    let upload = payload(
        json!({"owning_note_id": "missing", "mime_type": "image/jpeg"}),
        &[1],
    );
    assert!(call(&view, "upload_asset_bytes", InvokeBody::Raw(upload)).is_err());
    let _pause = app
        .state::<mindstream_notes_lib::vault_jobs::Saves>()
        .pause()
        .unwrap();
    let upload = payload(
        json!({"owning_note_id": note.summary.id, "mime_type": "image/jpeg"}),
        &[1],
    );
    assert!(call(&view, "upload_asset_bytes", InvokeBody::Raw(upload)).is_err());
    assert!(call(
        &view,
        "import_pdf_note_bytes",
        InvokeBody::Raw(payload(json!({}), &[1]))
    )
    .is_err());
}

#[test]
fn signed_ink_index_commands_reject_stale_text_without_dirtying_the_note() {
    let (app, view) = fixture();
    let db = app.state::<Db>();
    let note = db
        .with_conn(|c| {
            mindstream_notes_lib::notes::create(
                c,
                mindstream_notes_lib::notes::CreateNote {
                    title: Some("Ink".into()),
                    body: None,
                    parent_collection_id: None,
                    note_kind: Some(mindstream_notes_lib::notes::NoteKind::Ink),
                },
            )
        })
        .unwrap();
    db.with_conn(|c| {
        c.execute(
            "UPDATE notes SET dirty = 0 WHERE id = ?1",
            [&note.summary.id],
        )?;
        Ok(())
    })
    .unwrap();
    let needs = || {
        call(
            &view,
            "pdf_note_needs_text",
            InvokeBody::Json(json!({"noteId": note.summary.id})),
        )
        .unwrap()
        .deserialize::<bool>()
        .unwrap()
    };
    call(
        &view,
        "set_pdf_text",
        InvokeBody::Json(
            json!({"noteId": note.summary.id, "text": "stale text", "expectedSignature": "obsolete"}),
        ),
    )
    .unwrap();
    assert!(needs());
    call(
        &view,
        "set_pdf_text",
        InvokeBody::Json(
            json!({"noteId": note.summary.id, "text": "current text", "expectedSignature": "[]"}),
        ),
    )
    .unwrap();
    assert!(!needs());
    let stored: (String, String, i64, String) = db
        .with_conn(|c| {
            c.query_row(
                "SELECT pdf_text, pdf_text_signature, dirty, modified FROM notes WHERE id = ?1",
                [&note.summary.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(Into::into)
        })
        .unwrap();
    assert_eq!(
        stored,
        ("current text".into(), "[]".into(), 0, note.summary.modified)
    );
}

#[test]
fn text_cache_commands_persist_empty_pages_separately_and_reject_old_extraction_versions() {
    let (app, view) = fixture();
    let note = imported(&view, false);
    let asset: Value = serde_json::from_str(&note.body).unwrap();
    let read = |index, text: Option<&str>| {
        let mut body = json!({"assetId": asset["pdfAssetId"], "pageIndex": index});
        if let Some(text) = text {
            body["text"] = json!(text);
        }
        call(&view, "pdf_page_text", InvokeBody::Json(body))
            .unwrap()
            .deserialize::<Option<String>>()
            .unwrap()
    };
    assert_eq!(read(0, None), None);
    assert_eq!(read(0, Some("")), Some(String::new()));
    assert_eq!(read(1, Some("page two")), Some("page two".into()));
    assert_eq!(read(0, None), Some(String::new()));
    app.state::<Db>()
        .with_conn(|c| {
            c.execute("UPDATE pdf_page_text SET extraction_version = 0", [])?;
            Ok(())
        })
        .unwrap();
    assert_eq!(read(1, None), None);
    assert_eq!(read(1, Some("fresh")), Some("fresh".into()));
    let needs = || {
        call(
            &view,
            "pdf_note_needs_text",
            InvokeBody::Json(json!({"noteId": note.summary.id})),
        )
        .unwrap()
        .deserialize::<bool>()
        .unwrap()
    };
    assert!(needs());
    let missing: Vec<String> = call(&view, "pdf_notes_missing_text", InvokeBody::Json(json!({})))
        .unwrap()
        .deserialize()
        .unwrap();
    assert!(missing.contains(&note.summary.id));
    call(
        &view,
        "set_pdf_text",
        InvokeBody::Json(json!({"noteId": note.summary.id, "text": "searchable kiwi"})),
    )
    .unwrap();
    assert!(!needs());
}

#[test]
fn ink_conversion_command_accepts_the_editor_payload_and_rejects_unreferenced_assets() {
    let (_app, view) = fixture();
    let pdf = imported(&view, false);
    let body: Value = serde_json::from_str(&pdf.body).unwrap();
    let asset_id = body["pdfAssetId"].as_str().unwrap();
    let convert = |asset_id: &str, yrs_state: Vec<u8>| {
        call(
            &view,
            "import_ink_pdf_note",
            InvokeBody::Json(json!({"input": {
                "title": "Converted",
                "parent_collection_id": null,
                "bytes": [],
                "asset_id": asset_id,
                "yrs_state": yrs_state,
            }})),
        )
    };
    let pages = ink_pages(asset_id);
    let ink: Note = convert(asset_id, pages.clone())
        .unwrap()
        .deserialize()
        .unwrap();
    assert_eq!(ink.summary.title, "Converted");
    assert_eq!(ink.summary.note_kind.as_str(), "ink");
    assert_eq!(ink.yrs_state, pages);
    assert!(convert("asset_missing", ink_pages(asset_id)).is_err());
}
