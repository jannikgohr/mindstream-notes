//! Drive the export session commands through Tauri IPC with the mock runtime.
//! Folder exports write into a temporary directory; staged exports use a
//! temporary profile directory, so nothing touches the real app data.
use mindstream_notes_lib::db::Db;
use mindstream_notes_lib::export_session::ExportSessions;
use mindstream_notes_lib::paths::ActiveProfile;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, InvokeResponseBody};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};

struct Fixture {
    _app: tauri::App<MockRuntime>,
    view: tauri::WebviewWindow<MockRuntime>,
    profile: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let profile = tempfile::tempdir().unwrap();
        let app = mock_builder()
            .manage(Db::open(Path::new(":memory:")).unwrap())
            .manage(mindstream_notes_lib::vault_jobs::Jobs::default())
            .manage(mindstream_notes_lib::vault_jobs::Saves::default())
            .manage(ExportSessions::default())
            .manage(ActiveProfile {
                id: "test".into(),
                dir: profile.path().to_path_buf(),
            })
            .invoke_handler(tauri::generate_handler![
                mindstream_notes_lib::notes::create_note,
                mindstream_notes_lib::assets::binary::upload_asset_bytes,
                mindstream_notes_lib::export_session::export_begin,
                mindstream_notes_lib::export_session::export_write,
                mindstream_notes_lib::export_session::export_copy_asset,
                mindstream_notes_lib::export_session::export_asset_types,
                mindstream_notes_lib::export_session::export_finish,
                mindstream_notes_lib::export_session::export_abort,
            ])
            .build(mock_context(noop_assets()))
            .unwrap();
        let view = tauri::WebviewWindowBuilder::new(&app, "test", Default::default())
            .build()
            .unwrap();
        Self {
            _app: app,
            view,
            profile,
        }
    }

    fn call(&self, command: &str, body: InvokeBody) -> Result<InvokeResponseBody, Value> {
        tauri::test::get_ipc_response(
            &self.view,
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

    fn json(&self, command: &str, args: Value) -> Result<InvokeResponseBody, Value> {
        self.call(command, InvokeBody::Json(args))
    }

    fn begin(&self, target: Value) -> String {
        self.json("export_begin", json!({ "target": target }))
            .unwrap()
            .deserialize()
            .unwrap()
    }

    /// Send one chunk the way the desktop bridge does, or as the JSON array
    /// Android's bridge turns every request body into.
    fn write(
        &self,
        token: &str,
        path: &str,
        first: bool,
        size: usize,
        chunk: &[u8],
        mobile: bool,
    ) -> Result<InvokeResponseBody, Value> {
        let payload = payload(
            json!({ "token": token, "path": path, "first": first, "size": size }),
            chunk,
        );
        let body = if mobile {
            InvokeBody::Json(json!(payload))
        } else {
            InvokeBody::Raw(payload)
        };
        self.call("export_write", body)
    }

    fn upload(&self, mime: &str, bytes: &[u8]) -> String {
        let note: Value = self
            .json("create_note", json!({ "input": { "title": "Owner" } }))
            .unwrap()
            .deserialize()
            .unwrap();
        let payload = payload(
            json!({ "owning_note_id": note["id"], "mime_type": mime }),
            bytes,
        );
        let summary: Value = self
            .call("upload_asset_bytes", InvokeBody::Raw(payload))
            .unwrap()
            .deserialize()
            .unwrap();
        summary["id"].as_str().unwrap().to_string()
    }

    fn staging(&self) -> PathBuf {
        self.profile.path().join("exports/.staging")
    }

    fn staged_sessions(&self) -> usize {
        std::fs::read_dir(self.staging())
            .map(|entries| entries.count())
            .unwrap_or(0)
    }
}

fn payload(metadata: Value, bytes: &[u8]) -> Vec<u8> {
    let metadata = serde_json::to_vec(&metadata).unwrap();
    let mut payload = (metadata.len() as u32).to_le_bytes().to_vec();
    payload.extend(metadata);
    payload.extend(bytes);
    payload
}

fn message(error: Value) -> String {
    error.to_string()
}

#[test]
fn a_folder_export_joins_chunks_and_copies_assets_on_both_bridges() {
    for mobile in [false, true] {
        let fixture = Fixture::new();
        let root = tempfile::tempdir().unwrap();
        let picture = [137u8, 80, 78, 71, 0, 255];
        let asset = fixture.upload("image/png", &picture);

        let types: HashMap<String, String> = fixture
            .json(
                "export_asset_types",
                json!({ "ids": [asset.clone(), "asset_missing"] }),
            )
            .unwrap()
            .deserialize()
            .unwrap();
        assert_eq!(types, HashMap::from([(asset.clone(), "image/png".into())]));

        let token = fixture.begin(json!({ "kind": "folder", "root": root.path() }));
        fixture
            .write(&token, "Grüße/Köln.md", true, 6, b"# Do", mobile)
            .unwrap();
        fixture
            .write(&token, "Grüße/Köln.md", false, 6, b"m\n", mobile)
            .unwrap();
        fixture
            .json(
                "export_copy_asset",
                json!({
                    "token": token,
                    "path": format!("Grüße/_assets/{asset}.png"),
                    "assetId": asset,
                    "mimeType": "image/png"
                }),
            )
            .unwrap();
        let finished: bool = fixture
            .json("export_finish", json!({ "token": token }))
            .unwrap()
            .deserialize()
            .unwrap();
        assert!(finished);

        assert_eq!(
            std::fs::read(root.path().join("Grüße/Köln.md")).unwrap(),
            b"# Dom\n"
        );
        assert_eq!(
            std::fs::read(root.path().join(format!("Grüße/_assets/{asset}.png"))).unwrap(),
            picture
        );
        assert!(
            fixture
                .write(&token, "late.md", true, 1, b"x", mobile)
                .is_err(),
            "a finished session takes no more writes"
        );
    }
}

#[test]
fn asset_copies_check_the_stored_type_and_that_the_asset_exists() {
    let fixture = Fixture::new();
    let root = tempfile::tempdir().unwrap();
    let asset = fixture.upload("image/png", &[1, 2, 3]);
    let token = fixture.begin(json!({ "kind": "folder", "root": root.path() }));
    let wrong_type = fixture
        .json(
            "export_copy_asset",
            json!({
                "token": token,
                "path": "doc.pdf",
                "assetId": asset,
                "mimeType": "application/pdf"
            }),
        )
        .unwrap_err();
    assert!(message(wrong_type).contains("unexpected type"));
    assert!(fixture
        .json(
            "export_copy_asset",
            json!({ "token": token, "path": "gone.png", "assetId": "asset_gone" }),
        )
        .is_err());
    assert!(!root.path().join("doc.pdf").exists());
}

#[test]
fn a_staged_export_needs_valid_save_options_and_cleans_up_either_way() {
    let fixture = Fixture::new();
    for target in [json!({ "kind": "archive" }), json!({ "kind": "file" })] {
        let token = fixture.begin(target);
        fixture
            .write(&token, "Note.md", true, 1, b"x", false)
            .unwrap();
        assert_eq!(fixture.staged_sessions(), 1);
        let missing = fixture
            .json("export_finish", json!({ "token": token }))
            .unwrap_err();
        assert!(message(missing).contains("Missing save options"));
        assert_eq!(fixture.staged_sessions(), 0);
    }

    let token = fixture.begin(json!({ "kind": "archive" }));
    let bad_filter = fixture
        .json(
            "export_finish",
            json!({
                "token": token,
                "save": {
                    "suggestedName": "vault.zip",
                    "filterName": "ZIP",
                    "extensions": ["z.ip"]
                }
            }),
        )
        .unwrap_err();
    assert!(message(bad_filter).contains("filter"));
    assert_eq!(fixture.staged_sessions(), 0);
}

#[test]
fn abort_drops_the_staged_files_and_tolerates_unknown_tokens() {
    let fixture = Fixture::new();
    // A file still half written, as after a failed chunk.
    let file = fixture.begin(json!({ "kind": "file" }));
    fixture
        .write(&file, "Note.pdf", true, 10, b"%PDF", false)
        .unwrap();
    let token = fixture.begin(json!({ "kind": "archive" }));
    fixture
        .write(&token, "Note.md", true, 1, b"x", false)
        .unwrap();
    assert_eq!(fixture.staged_sessions(), 2);
    fixture
        .json("export_abort", json!({ "token": file }))
        .unwrap();
    fixture
        .json("export_abort", json!({ "token": token }))
        .unwrap();
    assert_eq!(fixture.staged_sessions(), 0);
    fixture
        .json("export_abort", json!({ "token": token }))
        .unwrap();
    let unknown = fixture
        .write(&token, "Note.md", true, 1, b"x", false)
        .unwrap_err();
    assert!(message(unknown).contains("Unknown or finished export"));
}

#[test]
fn the_first_staged_export_sweeps_what_a_crash_left_but_never_a_live_export() {
    let fixture = Fixture::new();
    let stale = fixture.staging().join("left-by-a-crash");
    std::fs::create_dir_all(&stale).unwrap();
    let first = fixture.begin(json!({ "kind": "archive" }));
    assert!(!stale.exists());
    fixture
        .write(&first, "Note.md", true, 1, b"x", false)
        .unwrap();

    // Starting more exports leaves the first one's staged files alone.
    let _second = fixture.begin(json!({ "kind": "file" }));
    let _third = fixture.begin(json!({ "kind": "archive" }));
    assert!(fixture.staging().join(&first).join("export.zip").exists());
    assert_eq!(fixture.staged_sessions(), 3);
}

#[test]
fn malformed_requests_are_refused() {
    let fixture = Fixture::new();
    let missing_root = tempfile::tempdir().unwrap().path().join("missing");
    assert!(fixture
        .json(
            "export_begin",
            json!({ "target": { "kind": "folder", "root": missing_root } }),
        )
        .is_err());

    let token = fixture.begin(json!({ "kind": "archive" }));
    let huge = vec![0u8; 16 * 1024 * 1024 + 1];
    let too_large = fixture
        .write(&token, "big.bin", true, huge.len(), &huge, false)
        .unwrap_err();
    assert!(message(too_large).contains("too large"));
    assert!(fixture
        .write(&token, "../escape.md", true, 1, b"x", false)
        .is_err());

    let ids: Vec<String> = (0..10_001).map(|i| format!("asset_{i}")).collect();
    assert!(fixture
        .json("export_asset_types", json!({ "ids": ids }))
        .is_err());
}
