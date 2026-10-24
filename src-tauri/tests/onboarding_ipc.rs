//! Real onboarding commands through Tauri's mock IPC runtime, isolated roots,
//! and in-memory vault databases. No native windows or user files are opened.
use mindstream_notes_lib::{
    db::Db,
    environment::{Environment, Kind},
    onboarding,
    paths::ActiveProfile,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tauri::{
    ipc::InvokeBody,
    test::{mock_builder, mock_context, noop_assets, MockRuntime},
    Listener, Manager,
};
use uuid::Uuid;

struct TestRoot(PathBuf);
impl TestRoot {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ms-onboarding-ipc-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        onboarding::initialize(&root, Kind::Release, false).unwrap();
        Self(root)
    }
    fn progress(&self) -> Value {
        serde_json::from_slice(&fs::read(self.0.join("onboarding.json")).unwrap()).unwrap()
    }
}
impl Drop for TestRoot {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn fixture(
    root: &Path,
    vault: Option<&str>,
) -> (tauri::App<MockRuntime>, tauri::WebviewWindow<MockRuntime>) {
    let app = mock_builder()
        .manage(Environment {
            kind: Kind::Test,
            root: root.to_path_buf(),
            credential_service: "onboarding-ipc-test".into(),
        })
        .manage(Db::open(Path::new(":memory:")).unwrap())
        .invoke_handler(tauri::generate_handler![
            onboarding::get_onboarding,
            onboarding::restart_onboarding,
            onboarding::save_onboarding_step,
            onboarding::finish_onboarding
        ])
        .build(mock_context(noop_assets()))
        .unwrap();
    if let Some(id) = vault {
        app.manage(ActiveProfile {
            id: id.into(),
            dir: root.join("profiles").join(id),
        });
    }
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (app, window)
}

fn call(
    window: &tauri::WebviewWindow<MockRuntime>,
    command: &str,
    body: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        window,
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
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|response| response.deserialize::<Value>().unwrap())
}

fn note_count(app: &tauri::App<MockRuntime>) -> u32 {
    app.state::<Db>()
        .with_conn(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))?))
        .unwrap()
}

#[test]
fn both_entry_points_claim_once_and_resume_the_saved_step() {
    for entry in ["get_onboarding", "restart_onboarding"] {
        let root = TestRoot::new();
        let (_app, window) = fixture(&root.0, Some("default"));
        let original = root.progress();
        let claimed = call(&window, entry, json!({})).unwrap();
        assert_eq!(claimed["id"], original["id"]);
        assert_eq!(claimed["vaultId"], "default");
        assert_eq!(claimed["freshInstall"], true);
        let saved = call(
            &window,
            "save_onboarding_step",
            json!({"id": claimed["id"], "step": "editing"}),
        )
        .unwrap();
        assert_eq!(saved["step"], "editing");
        for command in ["get_onboarding", "restart_onboarding"] {
            assert_eq!(call(&window, command, json!({})).unwrap(), saved);
        }
        assert_eq!(root.progress(), saved);
    }
}

#[test]
fn every_command_requires_an_active_vault_and_a_main_window() {
    let root = TestRoot::new();
    let (_missing_app, missing) = fixture(&root.0, None);
    let (app, _main) = fixture(&root.0, Some("default"));
    let popout = tauri::WebviewWindowBuilder::new(&app, "note-test", Default::default())
        .build()
        .unwrap();
    let original = root.progress();
    let args = json!({"id": original["id"], "step": "editing", "skipped": false, "demoNotes": [], "initialNote": null});
    for command in [
        "get_onboarding",
        "restart_onboarding",
        "save_onboarding_step",
        "finish_onboarding",
    ] {
        assert!(
            call(&missing, command, args.clone()).unwrap_err()["message"]
                .as_str()
                .unwrap()
                .contains("no active vault")
        );
        assert!(call(&popout, command, args.clone()).unwrap_err()["message"]
            .as_str()
            .unwrap()
            .contains("main window"));
        assert_eq!(root.progress(), original);
    }
    assert_eq!(note_count(&app), 0);
}

#[test]
fn another_vault_cannot_restart_advance_or_finish_the_claimed_session() {
    let root = TestRoot::new();
    let (_owner_app, owner) = fixture(&root.0, Some("default"));
    let (other_app, other) = fixture(&root.0, Some("other"));
    let claimed = call(&owner, "get_onboarding", json!({})).unwrap();
    assert_eq!(call(&other, "get_onboarding", json!({})).unwrap(), claimed);
    assert!(
        call(&other, "restart_onboarding", json!({})).unwrap_err()["message"]
            .as_str()
            .unwrap()
            .contains("another vault")
    );
    for command in ["save_onboarding_step", "finish_onboarding"] {
        let error = call(&other, command, json!({"id": claimed["id"], "step": "editing", "skipped": false, "demoNotes": [], "initialNote": {"title": "Wrong vault", "body": "must not be written"}})).unwrap_err();
        assert_eq!(error["code"], "invalidArgument");
        assert!(error["message"]
            .as_str()
            .unwrap()
            .contains("session changed"));
    }
    assert_eq!(root.progress(), claimed);
    assert_eq!(note_count(&other_app), 0);
    assert!(call(
        &owner,
        "save_onboarding_step",
        json!({"id": Uuid::new_v4(), "step": "editing"})
    )
    .is_err());
}

#[test]
fn completion_emits_a_change_and_retries_without_duplicating_notes() {
    let root = TestRoot::new();
    let (app, window) = fixture(&root.0, Some("default"));
    let claimed = call(&window, "get_onboarding", json!({})).unwrap();
    let events = Arc::new(AtomicUsize::new(0));
    let received = events.clone();
    app.listen("onboarding-changed", move |_| {
        received.fetch_add(1, Ordering::SeqCst);
    });
    let first = call(&window, "finish_onboarding", json!({"id": claimed["id"], "skipped": false, "demoNotes": [], "initialNote": {"title": "First note", "body": "# Welcome"}})).unwrap();
    let retry = call(
        &window,
        "finish_onboarding",
        json!({"id": claimed["id"], "skipped": false, "demoNotes": [], "initialNote": null}),
    )
    .unwrap();
    assert_eq!(first, retry);
    assert_eq!(first["progress"]["status"], "completed");
    assert!(first["noteId"].as_str().unwrap().starts_with("onboarding_"));
    assert_eq!(events.load(Ordering::SeqCst), 2);
    assert_eq!(note_count(&app), 1);

    let restarted = call(&window, "restart_onboarding", json!({})).unwrap();
    assert_ne!(restarted["id"], claimed["id"]);
    assert_eq!(restarted["freshInstall"], false);
    assert_eq!(restarted["vaultId"], "default");
    assert_eq!(restarted["step"], "account");
    let skipped = call(
        &window,
        "finish_onboarding",
        json!({"id": restarted["id"], "skipped": true, "demoNotes": [], "initialNote": null}),
    )
    .unwrap();
    assert_eq!(skipped["progress"]["status"], "skipped");
    assert_eq!(skipped["noteId"], Value::Null);
    assert_eq!(
        call(
            &window,
            "finish_onboarding",
            json!({"id": restarted["id"], "skipped": true, "demoNotes": [], "initialNote": null})
        )
        .unwrap(),
        skipped
    );
    assert_eq!(note_count(&app), 1);
}

#[test]
fn demo_notes_are_stored_through_ipc_and_retries_preserve_edits() {
    use yrs::{Doc, ReadTxn, StateVector, Transact, XmlElementPrelim, XmlFragment, XmlTextPrelim};

    let doc = Doc::with_client_id(1);
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    {
        let mut txn = doc.transact_mut();
        let paragraph = fragment.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        paragraph.push_back(&mut txn, XmlTextPrelim::new("Hello"));
    }
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let root = TestRoot::new();
    let (app, window) = fixture(&root.0, Some("default"));
    let claimed = call(&window, "get_onboarding", json!({})).unwrap();
    let args = json!({
        "id": claimed["id"],
        "skipped": false,
        "initialNote": null,
        "demoNotes": [{
            "slug": "welcome", "lang": "en", "title": "Welcome",
            "body": "Hello\n", "yrsState": state
        }]
    });
    let finished = call(&window, "finish_onboarding", args.clone()).unwrap();
    let note_id = finished["noteId"].as_str().unwrap();
    assert!(note_id.starts_with("demo_welcome_en_"));
    assert_eq!(finished["progress"]["status"], "completed");
    assert_eq!(root.progress()["initialNoteId"], note_id);
    app.state::<Db>()
        .with_conn(|conn| {
            let stored: (String, String, Vec<u8>, i64, i64) = conn.query_row(
                "SELECT title, body, yrs_state, payload_schema, dirty FROM notes WHERE id = ?1",
                [note_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )?;
            assert_eq!(stored, ("Welcome".into(), "Hello\n".into(), state, 2, 0));
            conn.execute(
                "UPDATE notes SET title = 'Mine', dirty = 1 WHERE id = ?1",
                [note_id],
            )?;
            Ok(())
        })
        .unwrap();
    // Retry after the note committed but progress publication failed.
    fs::write(
        root.0.join("onboarding.json"),
        serde_json::to_vec(&claimed).unwrap(),
    )
    .unwrap();
    assert_eq!(call(&window, "finish_onboarding", args).unwrap(), finished);
    assert_eq!(note_count(&app), 1);
    app.state::<Db>()
        .with_conn(|conn| {
            let stored: (String, i64) = conn.query_row(
                "SELECT title, dirty FROM notes WHERE id = ?1",
                [note_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(stored, ("Mine".into(), 1));
            Ok(())
        })
        .unwrap();
}

#[test]
fn invalid_initial_content_leaves_progress_and_database_unchanged() {
    let root = TestRoot::new();
    let (app, window) = fixture(&root.0, Some("default"));
    let claimed = call(&window, "get_onboarding", json!({})).unwrap();
    for note in [
        json!({"title": "", "body": "body"}),
        json!({"title": "x".repeat(513), "body": ""}),
        json!({"title": "Valid title", "body": "x".repeat(32769)}),
    ] {
        let error = call(
            &window,
            "finish_onboarding",
            json!({"id": claimed["id"], "skipped": false, "demoNotes": [], "initialNote": note}),
        )
        .unwrap_err();
        assert_eq!(error["code"], "invalidArgument");
        assert!(error["message"]
            .as_str()
            .unwrap()
            .contains("invalid initial note"));
        assert_eq!(root.progress(), claimed);
        assert_eq!(note_count(&app), 0);
    }
    let allowed = call(&window, "finish_onboarding", json!({"id": claimed["id"], "skipped": false, "demoNotes": [], "initialNote": {"title": "x".repeat(512), "body": "x".repeat(32768)}})).unwrap();
    assert_eq!(allowed["progress"]["status"], "completed");
    assert_eq!(note_count(&app), 1);
}

#[test]
fn retry_after_note_creation_preserves_edits_to_that_note() {
    let root = TestRoot::new();
    let (app, window) = fixture(&root.0, Some("default"));
    let claimed = call(&window, "get_onboarding", json!({})).unwrap();
    let args = json!({"id": claimed["id"], "skipped": false, "demoNotes": [], "initialNote": {"title": "Original title", "body": "Original body"}});
    let finished = call(&window, "finish_onboarding", args.clone()).unwrap();
    let note_id = finished["noteId"].as_str().unwrap();
    app.state::<Db>()
        .with_conn(|conn| {
            conn.execute(
                "UPDATE notes SET body = 'User-edited body' WHERE id = ?1",
                [note_id],
            )?;
            Ok(())
        })
        .unwrap();
    // Simulate a retry after the note committed but progress publication failed.
    fs::write(
        root.0.join("onboarding.json"),
        serde_json::to_vec(&claimed).unwrap(),
    )
    .unwrap();
    let retry = call(&window, "finish_onboarding", args).unwrap();
    assert_eq!(retry["noteId"], finished["noteId"]);
    let (title, body): (String, String) = app
        .state::<Db>()
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT title, body FROM notes WHERE id = ?1",
                [note_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(title, "Original title");
    assert_eq!(body, "User-edited body");
    assert_eq!(note_count(&app), 1);
}

#[test]
fn corrupt_progress_recovers_a_valid_previous_copy_and_preserves_evidence() {
    let root = TestRoot::new();
    let (_app, window) = fixture(&root.0, Some("default"));
    let claimed = call(&window, "get_onboarding", json!({})).unwrap();
    fs::write(root.0.join("onboarding.json"), b"damaged progress").unwrap();
    assert_eq!(call(&window, "get_onboarding", json!({})).unwrap(), claimed);
    let quarantined = fs::read_dir(&root.0)
        .unwrap()
        .find_map(|entry| {
            let path = entry.unwrap().path();
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("onboarding.json.corrupt-")
                .then_some(path)
        })
        .unwrap();
    assert_eq!(fs::read(quarantined).unwrap(), b"damaged progress");
}

#[test]
fn unsupported_progress_is_rejected_without_discarding_saved_bytes() {
    for invalid in [
        json!({"version": 2}),
        json!({"id": Uuid::nil()}),
        json!({"password": "must not be accepted"}),
    ] {
        let root = TestRoot::new();
        let (_app, window) = fixture(&root.0, Some("default"));
        let mut saved = root.progress();
        saved
            .as_object_mut()
            .unwrap()
            .extend(invalid.as_object().unwrap().clone());
        let raw = serde_json::to_vec(&saved).unwrap();
        fs::write(root.0.join("onboarding.json"), &raw).unwrap();
        assert!(call(&window, "get_onboarding", json!({})).is_err());
        assert_eq!(fs::read(root.0.join("onboarding.json")).unwrap(), raw);
    }
}
