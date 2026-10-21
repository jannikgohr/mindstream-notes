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
/// The same plugin written in TypeScript and built with the SDK. Every
/// shared test runs against both, so the SDK cannot drift from what a
/// component built straight from the WIT sees.
const CONFORMANCE_TS: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../plugin-sdk/conformance/dist/conformance-ts.wasm"
));
const COMPONENTS: [(&str, &[u8]); 2] = [("rust", CONFORMANCE), ("ts", CONFORMANCE_TS)];

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
        ["/usr/bin/true", "/bin/true", "/system/bin/true"]
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
    fn of(component: &'static [u8], permissions: &[&str]) -> Self {
        Self {
            component,
            ..Self::new(permissions)
        }
    }

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
fn bundled_code_prepares_without_running_and_seeds_the_disk_cache() {
    use super::precompiled::{TrustedPrecompiled, VerifiedComponent};
    use std::io::Write;
    for execution in [Execution::Native, Execution::Interpreter] {
        let runtime = WasmRuntime::new(execution).unwrap();
        let component = VerifiedComponent::new(CONFORMANCE.to_vec());
        let compiled = runtime.engine().precompile_component(&component).unwrap();
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gzip.write_all(&compiled).unwrap();
        let gzip = gzip.finish().unwrap();
        let engine = cache::engine_key(runtime.engine());
        // SAFETY: code compiled immediately above with this runtime's engine.
        let artifact = unsafe {
            TrustedPrecompiled::new(component.digest(), cache::digest(&compiled), &engine, &gzip)
        };
        let root = scratch();
        assert_eq!(
            runtime
                .prepare_component(&component, Some(&root), Some(&artifact))
                .unwrap(),
            cache::Source::Bundled
        );
        assert_eq!(runtime.running(), 0);
        assert_eq!(
            runtime
                .prepare_component(&component, Some(&root), None)
                .unwrap(),
            cache::Source::Memory
        );
        // Counter must be 1 on every call: preparation ran no guest, and
        // cached compiled code never retains a guest instance.
        for _ in 0..2 {
            assert_eq!(
                Call::new(&[])
                    .run_on(&runtime, "counter", json!({}))
                    .unwrap(),
                json!(1)
            );
        }
        runtime.clear_memory_cache();
        assert_eq!(
            runtime
                .prepare_component(&component, Some(&root), None)
                .unwrap(),
            cache::Source::Disk
        );
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn rust_templates_prototype_matches_typescript_outputs() {
    const RUST: &[u8] =
        include_bytes!("../../../../plugin-sdk/prototypes/templates-rust/plugin.wasm");
    const BATCH: &[u8] =
        include_bytes!("../../../../plugin-sdk/prototypes/templates-rust/plugin-batch.wasm");
    const LOCAL: &[u8] = include_bytes!(
        "../../../../plugin-sdk/prototypes/templates-rust/plugin-local-calendar.wasm"
    );
    const TYPESCRIPT: &[u8] = include_bytes!("../../../../plugins/templates/plugin.wasm");
    let zone = iana_time_zone::get_timezone().expect("host IANA timezone for candidate parity");
    // Debug builds make Pulley's host interpreter too slow for menu fixtures
    // under the production budget. Release tests/probes cover that backend.
    for runtime in std::iter::once(runtime()).chain((!cfg!(debug_assertions)).then(interpreter)) {
        for mut input in [
            json!({"now":"2026-07-25T10:00:00Z","locale":"de","title":"Log {{date:YYYY}}","body":"{{title|upper}} {{date-1M+2d:YYYY-MM-DD}} {{date+7d:dddd}}"}),
            json!({"now":"2026-01-31T12:00:00Z","body":"{{date+1M:YYYY-MM-DD}} {{date-1y+2w:YYYY-MM-DD}} {{word|trim|capitalize}}/{{word|slug}}/{{flag}}/{{number}}/{{missing}}/{{word|unknown}}","vars":{"word":"  hÄllo WORLD  ","flag":false,"number":42}}),
            json!({"now":"2026-07-25T10:00:00Z","title":"{{unknown}}","body":"{{date:}} {{multi\nline}} {{literal","vars":{"multi\nline":"yes"}}),
            json!({"body":"{{word|capitalize}}/{{word|upper}}/{{arr}}/{{obj}}/{{float}}","vars":{"word":"😀café","arr":[1,null,true,["a","b"]],"obj":{},"float":1.0}}),
            json!({"now":"2028-01-31T00:30:00Z","body":"{{date+1M:YYYY-MM-DD HH:mm:ss}}/{{date-1y:dddd}}"}),
            json!({"now":"2026-03-28T11:00:00Z","body":"{{date+1d:YYYY-MM-DD HH:mm}}/{{date+1M:YYYY-MM-DD HH:mm}}"}),
            json!({"now":"2026-01-29T01:30:00Z","body":"{{date+2M:YYYY-MM-DD HH:mm}}"}),
            json!({"now":"2026-08-25T00:30:00Z","body":"{{date+2M:YYYY-MM-DD HH:mm}}"}),
            json!({"now":"2026-07-25T10:00:00Z","title":"{{date:YYYY}}","body":"{{date+1M-2d:YYYY-MM-DD}} ".repeat(50)}),
        ] {
            input["timeZone"] = json!(zone);
            let run = |component| {
                Call::of(component, &[])
                    .run_on(runtime, "renderTemplate", input.clone())
                    .unwrap()
            };
            let expected = run(TYPESCRIPT);
            assert_eq!(run(RUST), expected, "{input}");
            assert_eq!(run(LOCAL), expected, "{input}");
            assert_eq!(run(BATCH), expected, "{input}");
        }
        for input in [
            json!({}),
            json!({"settings":{"source-tag":"missing"}}),
            json!({
                "settings":{"source-folder":"root","source-tag":"template"},
                "folders":[{"id":"root","parentId":null},{"id":"child","parentId":"root"},{"id":"cycle","parentId":"cycle"}]
            }),
        ] {
            let run = |component| {
                let mut call = Call::of(component, &[PERM_NOTES_READ]);
                // Keep debug-mode interpreter parity below the unchanged
                // one-second budget. The release probe measures 500 notes.
                call.notes = (0..50)
                    .map(|i| {
                        let mut note = note(
                            &format!("n{i}"),
                            ["Zulu", "Alpha", "😀", "\u{e000}", "Alpha"][i % 5],
                            if i % 3 == 0 { &["template"] } else { &[] },
                        );
                        note.folder_id = Some(if i % 2 == 0 { "child" } else { "cycle" }.into());
                        note
                    })
                    .collect();
                call.run_on(runtime, "newFromTemplate", input.clone())
                    .unwrap()
            };
            let expected = run(TYPESCRIPT);
            assert_eq!(run(RUST), expected, "{input}");
            assert_eq!(run(LOCAL), expected, "{input}");
            assert_eq!(run(BATCH), expected, "{input}");
        }
    }
}

#[test]
fn bundled_artifact_mismatch_falls_back_to_portable_wasm() {
    use super::precompiled::{TrustedPrecompiled, VerifiedComponent};
    use std::io::Write;
    let runtime = WasmRuntime::new(Execution::Native).unwrap();
    let component = VerifiedComponent::new(CONFORMANCE.to_vec());
    let compiled = runtime.engine().precompile_component(&component).unwrap();
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gzip.write_all(&compiled).unwrap();
    let gzip = gzip.finish().unwrap();
    let engine = cache::engine_key(runtime.engine());
    for (source, hash, key, bytes) in [
        (
            [0; 32],
            cache::digest(&compiled),
            engine.as_str(),
            gzip.as_slice(),
        ),
        (
            component.digest(),
            [0; 32],
            engine.as_str(),
            gzip.as_slice(),
        ),
        (
            component.digest(),
            cache::digest(&compiled),
            "other-engine",
            gzip.as_slice(),
        ),
        (
            component.digest(),
            cache::digest(&compiled),
            engine.as_str(),
            b"bad gzip".as_slice(),
        ),
    ] {
        // SAFETY: native bytes, when present, came from this test's engine.
        let artifact = unsafe { TrustedPrecompiled::new(source, hash, key, bytes) };
        runtime.clear_memory_cache();
        assert_eq!(
            runtime
                .prepare_component(&component, None, Some(&artifact))
                .unwrap(),
            cache::Source::Compiled
        );
    }
    // A caller cannot pair verified bytes with another buffer and reuse its hash.
    assert!(runtime
        .prepare_verified(b"invalid wasm", Some(&component), None, None)
        .is_err());
}

#[test]
fn a_call_with_every_permission_reaches_every_host_interface() {
    for (lang, component) in COMPONENTS {
        let root = scratch();
        let mut call = Call::of(component, ALL);
        call.data_root = Some(root.clone());
        call.notes = vec![note("n1", "Alpha", &["a"]), note("n2", "Beta", &[])];
        call.tools.insert("echo".into(), true_tool());
        let report = call.run("report", json!({ "tool": "echo" })).unwrap();

        assert_eq!(report["uuidLength"], 36, "{lang}");
        assert_eq!(report["randomLength"], 16, "{lang}");
        assert_eq!(
            report["permissions"],
            json!({ "notes.read": true, "pluginStorage.read": true, "pluginStorage.write": true, "nativeTools.runDeclared": true }),
            "{lang}"
        );

        let clock = &report["clock"];
        assert_eq!(clock["nowMillisIsRecent"], true, "{lang}");
        assert_eq!(clock["nowHasOffset"], true, "{lang}");
        assert_eq!(clock["format"]["ok"], "2026", "{lang}");
        assert_eq!(clock["monthName"]["ok"], "Juli", "{lang}");
        assert_eq!(clock["addMonth"]["ok"], "2026-08", "{lang}");
        assert_eq!(err_kind(&clock["badTimestamp"]), "invalid", "{lang}");

        assert_eq!(
            report["frontmatter"]["ok"], "---\ntags:\n  - \"a\"\n  - \"b\"\ntitle: \"Hi\"\n---\n",
            "{lang}"
        );

        let notes = &report["notes"];
        assert_eq!(notes["all"]["ok"].as_array().unwrap().len(), 2, "{lang}");
        assert_eq!(
            notes["get"]["ok"],
            json!({ "id": "n1", "title": "Alpha", "tags": ["a"], "kind": "markdown", "folderId": "f1", "folderPath": "Work / Projects" }),
            "{lang}"
        );
        assert_eq!(notes["missing"]["ok"], true, "{lang}");

        let storage = &report["storage"];
        assert_eq!(storage["readBefore"]["ok"], Value::Null, "{lang}");
        assert_eq!(storage["write"]["ok"], Value::Null, "{lang}");
        assert_eq!(storage["readAfter"]["ok"], r#"{"n":1}"#, "{lang}");
        assert_eq!(
            storage["list"]["ok"],
            json!([{ "name": "state.json", "isDir": false, "sizeBytes": 7 }]),
            "{lang}"
        );
        assert_eq!(err_kind(&storage["escape"]), "invalid", "{lang}");
        assert_eq!(storage["delete"]["ok"], Value::Null, "{lang}");
        assert_eq!(storage["readDeleted"]["ok"], Value::Null, "{lang}");
        assert!(!root.parent().unwrap().join("escape.txt").exists());

        let tools = &report["tools"];
        assert_eq!(tools["available"]["ok"], true_tool().is_some(), "{lang}");
        assert_eq!(err_kind(&tools["undeclared"]), "invalid", "{lang}");
        std::fs::remove_dir_all(root).ok();
    }
}

#[test]
fn both_languages_report_the_same_thing() {
    // Field by field above; here the whole report, so nothing is missed.
    let reports: Vec<Value> = COMPONENTS
        .iter()
        .map(|(_, component)| {
            let root = scratch();
            let mut call = Call::of(component, ALL);
            call.data_root = Some(root.clone());
            call.notes = vec![note("n1", "Alpha", &["a"])];
            let report = call.run("report", json!({})).unwrap();
            std::fs::remove_dir_all(root).ok();
            report
        })
        .collect();
    assert_eq!(reports[0], reports[1]);
}

#[test]
fn without_permissions_every_capability_is_denied() {
    for (lang, component) in COMPONENTS {
        let root = scratch();
        let mut call = Call::of(component, &[]);
        call.data_root = Some(root.clone());
        call.notes = vec![note("n1", "Alpha", &[])];
        let report = call.run("report", json!({})).unwrap();
        assert_eq!(
            report["permissions"],
            json!({ "notes.read": false, "pluginStorage.read": false, "pluginStorage.write": false, "nativeTools.runDeclared": false }),
            "{lang}"
        );
        for path in ["/notes/all", "/notes/get", "/notes/missing"] {
            let outcome = report.pointer(path).unwrap();
            assert_eq!(err_kind(outcome), "denied", "{lang} {path}");
            assert_eq!(outcome["err"]["message"], "notes.read", "{lang} {path}");
        }
        for path in ["/storage/readBefore", "/storage/list"] {
            assert_eq!(
                report.pointer(path).unwrap()["err"]["message"],
                "pluginStorage.read",
                "{lang} {path}"
            );
        }
        for path in ["/storage/write", "/storage/delete", "/storage/escape"] {
            assert_eq!(
                report.pointer(path).unwrap()["err"]["message"],
                "pluginStorage.write",
                "{lang} {path}"
            );
        }
        assert_eq!(err_kind(&report["tools"]["available"]), "denied", "{lang}");
        // Helpers that need no permission still work.
        assert_eq!(report["clock"]["format"]["ok"], "2026", "{lang}");
        assert!(
            std::fs::read_dir(&root).unwrap().next().is_none(),
            "{lang}: nothing was written"
        );
        std::fs::remove_dir_all(root).ok();
    }
}

#[test]
fn read_alone_does_not_grant_write() {
    for (lang, component) in COMPONENTS {
        let root = scratch();
        let mut call = Call::of(component, &[PERM_STORAGE_READ]);
        call.data_root = Some(root.clone());
        let report = call.run("report", json!({})).unwrap();
        assert_eq!(report["storage"]["readBefore"]["ok"], Value::Null, "{lang}");
        assert_eq!(err_kind(&report["storage"]["write"]), "denied", "{lang}");
        std::fs::remove_dir_all(root).ok();
    }
}

#[test]
fn storage_without_a_data_directory_is_unavailable() {
    for (lang, component) in COMPONENTS {
        let call = Call::of(component, &[PERM_STORAGE_READ, PERM_STORAGE_WRITE]);
        let report = call.run("report", json!({})).unwrap();
        assert_eq!(
            err_kind(&report["storage"]["write"]),
            "unavailable",
            "{lang}"
        );
    }
}

#[test]
fn a_plugin_returns_declarative_effects_built_from_notes() {
    for (lang, component) in COMPONENTS {
        let mut call = Call::of(component, &[PERM_NOTES_READ]);
        call.notes = vec![
            note("b", "Beta", &["template"]),
            note("a", "Alpha", &["template"]),
            note("c", "Other", &[]),
        ];
        let effect = call
            .run("menu", json!({ "settings": { "tag": "template" } }))
            .unwrap();
        assert_eq!(
            effect,
            json!({ "effect": "openMenu", "items": [
                { "label": "Alpha", "run": { "effect": "createNoteFromNote", "sourceNoteId": "a" } },
                { "label": "Beta", "run": { "effect": "createNoteFromNote", "sourceNoteId": "b" } },
            ] }),
            "{lang}"
        );
        let none = call
            .run("menu", json!({ "settings": { "tag": "nothing" } }))
            .unwrap();
        assert_eq!(none["effect"], "toast", "{lang}");
    }
}

#[test]
fn input_reaches_the_guest_and_comes_back() {
    let input =
        json!({ "settings": { "x": [1, 2, 3] }, "now": "2026-07-25T10:00:00Z", "s": "ünïcödé" });
    for (lang, component) in COMPONENTS {
        assert_eq!(
            Call::of(component, &[]).run("echo", input.clone()).unwrap(),
            input,
            "{lang}"
        );
    }
}

#[test]
fn every_call_gets_a_fresh_instance() {
    for (lang, component) in COMPONENTS {
        let call = Call::of(component, &[]);
        for _ in 0..3 {
            assert_eq!(call.run("counter", json!({})).unwrap(), 1, "{lang}");
        }
    }
}

#[test]
fn an_infinite_loop_ends_at_the_deadline() {
    for (lang, component) in COMPONENTS {
        let mut call = Call::of(component, &[]);
        call.limits.timeout = Duration::from_millis(100);
        // Compile first, so the timing is of the call and not of Cranelift.
        call.run("echo", json!({})).unwrap();
        let started = Instant::now();
        let err = call.run("spin", json!({})).unwrap_err();
        assert!(matches!(err, HostError::Budget), "{lang}: {err}");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{lang}: {:?}",
            started.elapsed()
        );
    }
}

#[test]
fn a_running_call_can_be_cancelled() {
    for (lang, component) in COMPONENTS {
        let mut call = Call::of(component, &[]);
        call.limits.timeout = Duration::from_secs(5);
        // Compile first, so the timing is of the call and not of Cranelift.
        call.run("echo", json!({})).unwrap();
        let canceller = call.cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            canceller.cancel();
        });
        let started = Instant::now();
        let err = call.run("spin", json!({})).unwrap_err();
        assert!(matches!(err, HostError::Cancelled), "{lang}: {err}");
        assert!(started.elapsed() < Duration::from_secs(2), "{lang}");
    }
}

#[test]
fn runaway_allocation_stops_at_the_memory_limit() {
    for (lang, component) in COMPONENTS {
        let mut call = Call::of(component, &[]);
        call.limits.memory_bytes = 8 * 1024 * 1024;
        call.limits.timeout = Duration::from_secs(5);
        let err = call.run("grow", json!({})).unwrap_err().to_string();
        assert!(
            err.contains("ran out of memory at its 8 MiB limit"),
            "{lang}: {err}"
        );
        // The runtime is unaffected and the next call is fine.
        assert_eq!(call.run("echo", json!(1)).unwrap(), 1, "{lang}");
    }
}

#[test]
fn a_guest_error_and_bad_output_are_reported() {
    for (lang, component) in COMPONENTS {
        let call = Call::of(component, &[]);
        let err = call.run("fail", json!({})).unwrap_err().to_string();
        assert_eq!(err, "wasm (com.test.conformance): boom", "{lang}");
        let err = call.run("notJson", json!({})).unwrap_err().to_string();
        assert!(err.contains("not JSON"), "{lang}: {err}");
        let err = call.run("nope", json!({})).unwrap_err().to_string();
        assert!(err.contains("nope"), "{lang}: {err}");
        let err = call
            .run("randomTooMuch", json!({}))
            .unwrap_err()
            .to_string();
        assert!(err.contains("at most 65536 bytes"), "{lang}: {err}");
    }
    // A Rust panic is a trap: the host reports a crash, not an error value.
    let err = Call::new(&[])
        .run("panic", json!({}))
        .unwrap_err()
        .to_string();
    assert!(err.contains("plugin crashed"), "{err}");
}

#[test]
fn the_sdk_gives_typescript_a_working_clock_and_random_source() {
    let call = Call::of(CONFORMANCE_TS, &[]);
    let first = call.run("dateNow", json!({})).unwrap();
    let now = first["now"].as_f64().unwrap();
    assert!(now > 1.7e12, "{first}");
    assert!((first["constructed"].as_f64().unwrap() - now).abs() < 60_000.0);
    // Without the SDK's replacement, every instance starts from the same
    // snapshotted seed and returns the same numbers.
    let a = call.run("random", json!({})).unwrap();
    let b = call.run("random", json!({})).unwrap();
    assert_ne!(a, b);
}

#[test]
fn output_larger_than_guest_memory_cannot_be_built() {
    for (lang, component) in COMPONENTS {
        let mut call = Call::of(component, &[]);
        call.limits.memory_bytes = 4 * 1024 * 1024;
        let err = call
            .run("bigOutput", json!({ "bytes": 8 * 1024 * 1024 }))
            .unwrap_err();
        assert!(
            err.to_string().contains("ran out of memory"),
            "{lang}: {err}"
        );
        let ok = call.run("bigOutput", json!({ "bytes": 1024 })).unwrap();
        assert_eq!(ok.as_str().unwrap().len(), 1024, "{lang}");
    }
}

#[test]
fn native_tools_run_and_a_tool_loop_ends_at_the_call_ceiling() {
    let Some(tool) = true_tool() else { return };
    for (lang, component) in COMPONENTS {
        let root = scratch();
        let mut call = Call::of(component, &[PERM_NATIVE_TOOLS]);
        call.data_root = Some(root.clone());
        call.tools.insert("t".into(), Some(tool.clone()));
        call.tools.insert("missing".into(), None);
        let args = if cfg!(windows) {
            json!(["/c", "exit", "0"])
        } else {
            json!([])
        };
        let out = call
            .run("runTool", json!({ "tool": "t", "args": args }))
            .unwrap();
        assert_eq!(out["ok"]["statusCode"], 0, "{lang}: {out}");
        assert_eq!(out["ok"]["timedOut"], false, "{lang}");
        let missing = call.run("runTool", json!({ "tool": "missing" })).unwrap();
        assert_eq!(err_kind(&missing), "unavailable", "{lang}");

        // Tool time is credited back to the script, so a loop of tool runs
        // is not stopped by the script budget. The fixed ceiling of timeout
        // plus allowance is what ends it.
        call.limits.timeout = Duration::from_millis(100);
        call.native_allowance = Duration::from_millis(400);
        // Compile first, so the timing is of the call and not of Cranelift.
        call.run("echo", json!({})).unwrap();
        let started = Instant::now();
        let err = call.run("toolLoop", json!({ "tool": "t" })).unwrap_err();
        assert!(matches!(err, HostError::Budget), "{lang}: {err}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{lang}: {:?}",
            started.elapsed()
        );
        std::fs::remove_dir_all(root).ok();
    }
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
    for (lang, component) in COMPONENTS {
        let root = scratch();
        let mut call = Call::of(component, ALL);
        call.data_root = Some(root.clone());
        call.notes = vec![note("n1", "Alpha", &["a"])];
        let native = call.run("report", json!({})).unwrap();
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(&root).unwrap();
        let interpreted = call.run_on(interpreter(), "report", json!({})).unwrap();
        assert_eq!(native, interpreted, "{lang}");

        call.limits.timeout = Duration::from_millis(100);
        let err = call.run_on(interpreter(), "spin", json!({})).unwrap_err();
        assert!(matches!(err, HostError::Budget), "{lang}: {err}");
        std::fs::remove_dir_all(root).ok();
    }
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

#[test]
fn batch_guest_preserves_indexed_permission_failures_and_prior_writes() {
    const BATCH: &[u8] =
        include_bytes!("../../../../plugin-sdk/prototypes/templates-rust/plugin-batch.wasm");
    for rt in [runtime(), interpreter()] {
        let err = Call::of(BATCH, &[])
            .run_on(rt, "$hostProbe", json!({"now":"2026-07-25T10:00:00Z"}))
            .unwrap_err();
        assert!(err.to_string().contains("batch 2:"));
        assert!(err.to_string().contains("notes.read"));
        let root = scratch();
        let mut call = Call::of(BATCH, &[PERM_NOTES_READ, PERM_STORAGE_WRITE]);
        call.data_root = Some(root.clone());
        let err = call
            .run_on(rt, "$hostProbe", json!({"now":"2026-07-25T10:00:00Z"}))
            .unwrap_err();
        assert!(err.to_string().contains("batch 6:"));
        assert!(err.to_string().contains("pluginStorage.read"));
        assert!(std::fs::read_to_string(root.join("batch-probe.txt"))
            .unwrap()
            .contains("Batch probe"));
        let failure = call
            .run_on(
                rt,
                "$hostProbe",
                json!({"now":"2026-07-25T10:00:00Z","reportFailure":true}),
            )
            .unwrap();
        assert_eq!(failure["index"], 6);
        assert_eq!(failure["phase"], "execution");
        assert_eq!(failure["completed"], 6);
        let replies = failure["replies"].as_array().unwrap();
        assert_eq!(
            replies
                .iter()
                .map(|r| r["index"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            [1, 2, 3, 4]
        );
        assert_eq!(replies[0]["value"], "2026-08-25");
        assert!(replies[2]["value"]
            .as_str()
            .unwrap()
            .contains("Batch probe"));
        assert_eq!(replies[3]["value"], true);
        std::fs::remove_dir_all(root).unwrap();
    }
}
