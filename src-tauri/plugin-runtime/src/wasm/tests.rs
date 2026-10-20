//! The Wasm runtime against the Rust conformance plugin in
//! `plugin-sdk/conformance`, plus a few hand-written hostile components.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::*;
use crate::cancel::CancelToken;
use crate::host::{
    NoteMeta, PERM_NATIVE_TOOLS, PERM_NOTES_READ, PERM_STORAGE_READ, PERM_STORAGE_WRITE,
};
use crate::limits;

const CONFORMANCE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../plugin-sdk/conformance/dist/conformance-rust.wasm"
));

const ALL: &[&str] = &[
    PERM_NOTES_READ,
    PERM_STORAGE_READ,
    PERM_STORAGE_WRITE,
    PERM_NATIVE_TOOLS,
];

fn runtime() -> &'static WasmRuntime {
    WasmRuntime::global().expect("the plugin runtime starts")
}

fn interpreter() -> &'static WasmRuntime {
    static INTERPRETER: OnceLock<WasmRuntime> = OnceLock::new();
    INTERPRETER.get_or_init(|| WasmRuntime::new(Execution::Interpreter).unwrap())
}

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ms-wasm-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn note(id: &str, title: &str, tags: &[&str]) -> NoteMeta {
    NoteMeta {
        id: id.into(),
        title: title.into(),
        tags: tags.iter().map(|t| t.to_string()).collect(),
        kind: "markdown".into(),
        folder_id: Some("f1".into()),
        folder_path: "Work / Projects".into(),
        created: "2026-07-26T00:00:00Z".into(),
        modified: "2026-07-26T00:00:00Z".into(),
    }
}

/// A shell-free tool that exits successfully, by platform.
fn true_tool() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        ["/usr/bin/true", "/bin/true"]
            .iter()
            .map(PathBuf::from)
            .find(|p| p.exists())
    }
    #[cfg(windows)]
    {
        std::env::var_os("COMSPEC").map(PathBuf::from)
    }
}

struct Call {
    native_allowance: Duration,
    permissions: Vec<String>,
    notes: Vec<NoteMeta>,
    tools: HashMap<String, Option<PathBuf>>,
    data_root: Option<PathBuf>,
    limits: Limits,
    cancel: CancelToken,
    component: &'static [u8],
}

impl Call {
    fn new(permissions: &[&str]) -> Self {
        Self {
            native_allowance: limits::NATIVE_ALLOWANCE,
            permissions: permissions.iter().map(|p| p.to_string()).collect(),
            notes: Vec::new(),
            tools: HashMap::new(),
            data_root: None,
            limits: limits::WASM.resolve(None, None),
            cancel: CancelToken::new(),
            component: CONFORMANCE,
        }
    }

    fn run_on(&self, rt: &WasmRuntime, export: &str, input: Value) -> HostResult<Value> {
        rt.invoke(WasmCall {
            component: self.component,
            export,
            input: &input,
            setup: CallSetup {
                plugin_id: "com.test.conformance".into(),
                permissions: self.permissions.clone(),
                notes: self.notes.clone(),
                native_tools: self.tools.clone(),
                data_root: self.data_root.clone(),
                cancel: self.cancel.clone(),
            },
            limits: self.limits,
            native_allowance: self.native_allowance,
            cache_dir: None,
        })
    }

    fn run(&self, export: &str, input: Value) -> HostResult<Value> {
        self.run_on(runtime(), export, input)
    }
}

fn err_kind(outcome: &Value) -> &str {
    outcome["err"]["kind"].as_str().unwrap_or("<ok>")
}

#[test]
fn a_call_with_every_permission_reaches_every_host_interface() {
    let root = scratch();
    let mut call = Call::new(ALL);
    call.data_root = Some(root.clone());
    call.notes = vec![note("n1", "Alpha", &["a"]), note("n2", "Beta", &[])];
    call.tools.insert("echo".into(), true_tool());
    let report = call.run("report", json!({ "tool": "echo" })).unwrap();

    assert_eq!(report["uuidLength"], 36);
    assert_eq!(report["randomLength"], 16);
    assert_eq!(
        report["permissions"],
        json!({ "notes.read": true, "pluginStorage.read": true, "pluginStorage.write": true, "nativeTools.runDeclared": true })
    );

    let clock = &report["clock"];
    assert_eq!(clock["nowMillisIsRecent"], true);
    assert_eq!(clock["nowHasOffset"], true);
    assert_eq!(clock["format"]["ok"], "2026");
    assert_eq!(clock["monthName"]["ok"], "Juli");
    assert_eq!(clock["addMonth"]["ok"], "2026-08");
    assert_eq!(err_kind(&clock["badTimestamp"]), "invalid");

    let fm = report["frontmatter"]["ok"].as_str().unwrap();
    assert!(
        fm.starts_with("---\n") && fm.contains("title: \"Hi\""),
        "{fm}"
    );

    let notes = &report["notes"];
    assert_eq!(notes["all"]["ok"].as_array().unwrap().len(), 2);
    assert_eq!(notes["get"]["ok"]["title"], "Alpha");
    assert_eq!(notes["get"]["ok"]["folderPath"], "Work / Projects");
    assert_eq!(notes["get"]["ok"]["folderId"], "f1");
    assert_eq!(notes["missing"]["ok"], true);

    let storage = &report["storage"];
    assert_eq!(storage["readBefore"]["ok"], Value::Null);
    assert_eq!(storage["write"]["ok"], Value::Null);
    assert_eq!(storage["readAfter"]["ok"], r#"{"n":1}"#);
    assert_eq!(
        storage["list"]["ok"],
        json!([{ "name": "state.json", "isDir": false, "sizeBytes": 7 }])
    );
    assert_eq!(err_kind(&storage["escape"]), "invalid");
    assert_eq!(storage["delete"]["ok"], Value::Null);
    assert_eq!(storage["readDeleted"]["ok"], Value::Null);
    assert!(!root.parent().unwrap().join("escape.txt").exists());

    let tools = &report["tools"];
    assert_eq!(tools["available"]["ok"], true_tool().is_some());
    assert_eq!(err_kind(&tools["undeclared"]), "invalid");
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn without_permissions_every_capability_is_denied() {
    let root = scratch();
    let mut call = Call::new(&[]);
    call.data_root = Some(root.clone());
    call.notes = vec![note("n1", "Alpha", &[])];
    let report = call.run("report", json!({})).unwrap();
    assert_eq!(
        report["permissions"],
        json!({ "notes.read": false, "pluginStorage.read": false, "pluginStorage.write": false, "nativeTools.runDeclared": false })
    );
    for path in ["/notes/all", "/notes/get", "/notes/missing"] {
        let outcome = report.pointer(path).unwrap();
        assert_eq!(err_kind(outcome), "denied", "{path}");
        assert_eq!(outcome["err"]["message"], "notes.read");
    }
    for path in ["/storage/readBefore", "/storage/list"] {
        assert_eq!(
            report.pointer(path).unwrap()["err"]["message"],
            "pluginStorage.read"
        );
    }
    for path in ["/storage/write", "/storage/delete", "/storage/escape"] {
        assert_eq!(
            report.pointer(path).unwrap()["err"]["message"],
            "pluginStorage.write"
        );
    }
    assert_eq!(err_kind(&report["tools"]["available"]), "denied");
    // Helpers that need no permission still work.
    assert_eq!(report["clock"]["format"]["ok"], "2026");
    assert!(
        std::fs::read_dir(&root).unwrap().next().is_none(),
        "nothing was written"
    );
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn read_alone_does_not_grant_write() {
    let root = scratch();
    let mut call = Call::new(&[PERM_STORAGE_READ]);
    call.data_root = Some(root.clone());
    let report = call.run("report", json!({})).unwrap();
    assert_eq!(report["storage"]["readBefore"]["ok"], Value::Null);
    assert_eq!(err_kind(&report["storage"]["write"]), "denied");
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn storage_without_a_data_directory_is_unavailable() {
    let call = Call::new(&[PERM_STORAGE_READ, PERM_STORAGE_WRITE]);
    let report = call.run("report", json!({})).unwrap();
    assert_eq!(err_kind(&report["storage"]["write"]), "unavailable");
}

#[test]
fn a_plugin_returns_declarative_effects_built_from_notes() {
    let mut call = Call::new(&[PERM_NOTES_READ]);
    call.notes = vec![
        note("b", "Beta", &["template"]),
        note("a", "Alpha", &["template"]),
        note("c", "Other", &[]),
    ];
    let effect = call
        .run("menu", json!({ "settings": { "tag": "template" } }))
        .unwrap();
    assert_eq!(effect["effect"], "openMenu");
    assert_eq!(
        effect["items"],
        json!([
            { "label": "Alpha", "run": { "effect": "createNoteFromNote", "sourceNoteId": "a" } },
            { "label": "Beta", "run": { "effect": "createNoteFromNote", "sourceNoteId": "b" } },
        ])
    );
    let none = call
        .run("menu", json!({ "settings": { "tag": "nothing" } }))
        .unwrap();
    assert_eq!(none["effect"], "toast");
}

#[test]
fn input_reaches_the_guest_and_comes_back() {
    let input =
        json!({ "settings": { "x": [1, 2, 3] }, "now": "2026-07-25T10:00:00Z", "s": "ünïcödé" });
    assert_eq!(Call::new(&[]).run("echo", input.clone()).unwrap(), input);
}

#[test]
fn every_call_gets_a_fresh_instance() {
    let call = Call::new(&[]);
    for _ in 0..3 {
        assert_eq!(call.run("counter", json!({})).unwrap(), 1);
    }
}

#[test]
fn an_infinite_loop_ends_at_the_deadline() {
    let mut call = Call::new(&[]);
    call.limits.timeout = Duration::from_millis(100);
    let started = Instant::now();
    let err = call.run("spin", json!({})).unwrap_err();
    assert!(matches!(err, HostError::Budget), "{err}");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn a_running_call_can_be_cancelled() {
    let mut call = Call::new(&[]);
    call.limits.timeout = Duration::from_secs(5);
    let canceller = call.cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(50));
        canceller.cancel();
    });
    let started = Instant::now();
    let err = call.run("spin", json!({})).unwrap_err();
    assert!(matches!(err, HostError::Cancelled), "{err}");
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn runaway_allocation_stops_at_the_memory_limit() {
    let mut call = Call::new(&[]);
    call.limits.memory_bytes = 8 * 1024 * 1024;
    call.limits.timeout = Duration::from_secs(5);
    let err = call.run("grow", json!({})).unwrap_err().to_string();
    assert!(
        err.contains("ran out of memory at its 8 MiB limit"),
        "{err}"
    );
    // The runtime is unaffected and the next call is fine.
    assert_eq!(call.run("echo", json!(1)).unwrap(), 1);
}

#[test]
fn a_guest_error_a_panic_and_bad_output_are_reported() {
    let call = Call::new(&[]);
    let err = call.run("fail", json!({})).unwrap_err().to_string();
    assert_eq!(err, "wasm (com.test.conformance): boom");
    let err = call.run("panic", json!({})).unwrap_err().to_string();
    assert!(err.contains("plugin crashed"), "{err}");
    let err = call.run("notJson", json!({})).unwrap_err().to_string();
    assert!(err.contains("not JSON"), "{err}");
    let err = call.run("nope", json!({})).unwrap_err().to_string();
    assert!(err.contains("unknown export nope"), "{err}");
    let err = call
        .run("randomTooMuch", json!({}))
        .unwrap_err()
        .to_string();
    assert!(err.contains("at most 65536 bytes"), "{err}");
}

#[test]
fn output_larger_than_guest_memory_cannot_be_built() {
    let mut call = Call::new(&[]);
    call.limits.memory_bytes = 4 * 1024 * 1024;
    let err = call
        .run("bigOutput", json!({ "bytes": 8 * 1024 * 1024 }))
        .unwrap_err();
    assert!(err.to_string().contains("ran out of memory"), "{err}");
    let ok = call.run("bigOutput", json!({ "bytes": 1024 })).unwrap();
    assert_eq!(ok.as_str().unwrap().len(), 1024);
}

#[test]
fn native_tools_run_and_a_tool_loop_ends_at_the_call_ceiling() {
    let Some(tool) = true_tool() else { return };
    let root = scratch();
    let mut call = Call::new(&[PERM_NATIVE_TOOLS]);
    call.data_root = Some(root.clone());
    call.tools.insert("t".into(), Some(tool));
    call.tools.insert("missing".into(), None);
    let args = if cfg!(windows) {
        json!(["/c", "exit", "0"])
    } else {
        json!([])
    };
    let out = call
        .run("runTool", json!({ "tool": "t", "args": args }))
        .unwrap();
    assert_eq!(out["ok"]["statusCode"], 0, "{out}");
    assert_eq!(out["ok"]["timedOut"], false);
    let missing = call.run("runTool", json!({ "tool": "missing" })).unwrap();
    assert_eq!(err_kind(&missing), "unavailable");

    // Tool time is credited back to the script, so a loop of tool runs is
    // not stopped by the script budget. The fixed ceiling of timeout plus
    // allowance is what ends it.
    call.limits.timeout = Duration::from_millis(100);
    call.native_allowance = Duration::from_millis(400);
    let canceller = call.cancel.clone();
    let watchdog = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(30));
        canceller.cancel();
    });
    let started = Instant::now();
    let err = call.run("toolLoop", json!({ "tool": "t" })).unwrap_err();
    assert!(matches!(err, HostError::Budget), "{err}");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    drop(watchdog);
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn a_component_that_imports_wasi_is_refused_by_name() {
    let wat = r#"(component
        (import "wasi:cli/environment@0.2.0" (instance
            (export "get-arguments" (func (result (list string))))
        ))
        (import "mindstream:plugin/runtime@0.1.0" (instance))
    )"#;
    let bytes = wat::parse_str(wat).unwrap();
    let err = runtime().validate(&bytes).unwrap_err().to_string();
    assert!(err.contains("wasi:cli/environment@0.2.0"), "{err}");
    assert!(err.contains("does not provide"), "{err}");
}

#[test]
fn a_component_without_the_invoke_export_is_refused() {
    let wat = r#"(component
        (core module $m (func (export "f")))
        (core instance $i (instantiate $m))
        (func (export "invoke") (canon lift (core func $i "f")))
    )"#;
    let err = runtime()
        .validate(&wat::parse_str(wat).unwrap())
        .unwrap_err()
        .to_string();
    assert!(err.contains("does not export `invoke`"), "{err}");
}

#[test]
fn bytes_that_are_not_a_component_are_refused() {
    let err = runtime().validate(b"\0asm junk").unwrap_err().to_string();
    assert!(err.contains("not a valid plugin component"), "{err}");
    let core_module = wat::parse_str("(module)").unwrap();
    assert!(runtime().validate(&core_module).is_err());
    let huge = vec![0u8; MAX_COMPONENT_BYTES + 1];
    let err = runtime().validate(&huge).unwrap_err().to_string();
    assert!(err.contains("more than the"), "{err}");
}

#[test]
fn compiled_components_are_cached_in_memory_and_on_disk() {
    let dir = scratch();
    let first = WasmRuntime::new(Execution::Native).unwrap();
    let call = |rt: &WasmRuntime| {
        rt.invoke_timed(WasmCall {
            component: CONFORMANCE,
            export: "echo",
            input: &json!(1),
            setup: CallSetup::default(),
            limits: limits::WASM.resolve(None, None),
            native_allowance: limits::NATIVE_ALLOWANCE,
            cache_dir: Some(&dir),
        })
        .unwrap()
        .1
    };
    assert_eq!(call(&first).source, cache::Source::Compiled);
    assert_eq!(call(&first).source, cache::Source::Memory);
    first.clear_memory_cache();
    assert_eq!(call(&first).source, cache::Source::Disk);

    // A fresh runtime, as after an app restart, skips compiling.
    let second = WasmRuntime::new(Execution::Native).unwrap();
    let timings = call(&second);
    assert_eq!(timings.source, cache::Source::Disk);
    assert!(timings.memory_bytes > 0);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn the_interpreter_gives_the_same_answers_as_native_code() {
    // What 32-bit Android runs, checked on this host.
    let root = scratch();
    let mut call = Call::new(ALL);
    call.data_root = Some(root.clone());
    call.notes = vec![note("n1", "Alpha", &["a"])];
    let mut native = call.run("report", json!({})).unwrap();
    std::fs::remove_dir_all(&root).ok();
    std::fs::create_dir_all(&root).unwrap();
    let mut interpreted = call.run_on(interpreter(), "report", json!({})).unwrap();
    // Two fresh UUIDs and two clocks are allowed to differ; nothing else is.
    for report in [&mut native, &mut interpreted] {
        report["clock"]["nowMillisIsRecent"] = Value::Null;
    }
    assert_eq!(native, interpreted);

    call.limits.timeout = Duration::from_millis(100);
    let err = call.run_on(interpreter(), "spin", json!({})).unwrap_err();
    assert!(matches!(err, HostError::Budget), "{err}");
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn concurrent_calls_beyond_the_cap_wait_then_fail_as_busy() {
    let slots = Slots::default();
    let a = slots.acquire(2, Duration::ZERO).unwrap();
    let _b = slots.acquire(2, Duration::ZERO).unwrap();
    let err = slots.acquire(2, Duration::from_millis(20)).unwrap_err();
    assert!(matches!(err, HostError::Unavailable(_)));
    drop(a);
    assert!(slots.acquire(2, Duration::ZERO).is_ok());
}

#[test]
fn the_ticker_runs_only_while_a_call_does() {
    let rt = WasmRuntime::new(Execution::Native).unwrap();
    assert_eq!(rt.running(), 0);
    {
        let _guard = rt.ticker.enter();
        assert_eq!(rt.running(), 1);
    }
    assert_eq!(rt.running(), 0);
}
