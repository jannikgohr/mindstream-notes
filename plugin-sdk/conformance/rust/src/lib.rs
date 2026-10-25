//! A plugin that calls every host interface and reports what came back.
//!
//! The runtime's tests and the conformance runner use it to check that a
//! host keeps the contract: the same calls, the same permission answers, the
//! same results, on every platform. It also has exports that try to break the
//! limits a host has to enforce.
//!
//! Every host call in a report is written as `{"ok": value}` or
//! `{"err": {"kind": ..., "message": ...}}`, so the expected results can be
//! compared as JSON.

use serde_json::{json, Value};

wit_bindgen::generate!({
    path: "../../wit",
    world: "mindstream:plugin/plugin",
});

use mindstream::plugin::types::Error;
use mindstream::plugin::{clock, markdown, native_tools, notes, runtime, storage};

struct Conformance;

/// Counts calls within one instance. A host that reused instances between
/// calls would let it climb past 1.
static CALLS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

fn outcome<T>(result: Result<T, Error>, ok: impl FnOnce(T) -> Value) -> Value {
    match result {
        Ok(value) => json!({ "ok": ok(value) }),
        Err(err) => {
            let (kind, message) = match err {
                Error::Denied(m) => ("denied", m),
                Error::Invalid(m) => ("invalid", m),
                Error::Unavailable(m) => ("unavailable", m),
                Error::Failed(m) => ("failed", m),
            };
            json!({ "err": { "kind": kind, "message": message } })
        }
    }
}

fn note_json(n: &mindstream::plugin::types::NoteMeta) -> Value {
    json!({
        "id": n.id,
        "title": n.title,
        "tags": n.tags,
        "kind": n.kind,
        "folderId": n.folder_id,
        "folderPath": n.folder_path,
    })
}

/// Call everything once.
fn report(input: &Value) -> Value {
    runtime::log(runtime::LogLevel::Info, "conformance report");
    let uuid = runtime::uuid();
    let random = runtime::random_bytes(16);
    let permissions: Value = [
        "notes.read",
        "pluginStorage.read",
        "pluginStorage.write",
        "nativeTools.runDeclared",
    ]
    .iter()
    .map(|p| (p.to_string(), Value::Bool(runtime::has_permission(p))))
    .collect::<serde_json::Map<_, _>>()
    .into();

    let fixed = "2026-07-25T10:00:00Z";
    let clock = json!({
        "nowMillisIsRecent": clock::now_millis() > 1_700_000_000_000,
        "nowHasOffset": clock::now().contains('T'),
        "format": outcome(clock::format(fixed, "YYYY", Some("en")), Value::from),
        "monthName": outcome(clock::format("2026-07-15T12:00:00Z", "MMMM", Some("de")), Value::from),
        "addMonth": outcome(
            clock::add(fixed, 1, clock::TimeUnit::Month).and_then(|t| clock::format(&t, "YYYY-MM", None)),
            Value::from,
        ),
        "badTimestamp": outcome(clock::format("not a date", "YYYY", None), Value::from),
    });

    let frontmatter = outcome(
        markdown::frontmatter(r#"{"title":"Hi","tags":["a","b"]}"#),
        Value::from,
    );

    let notes = json!({
        "all": outcome(notes::all(), |all| all.iter().map(note_json).collect::<Vec<_>>().into()),
        "get": outcome(notes::get("n1"), |n| n.as_ref().map(note_json).unwrap_or(Value::Null)),
        "missing": outcome(notes::get("no-such-note"), |n| Value::Bool(n.is_none())),
    });

    let storage = json!({
        "readBefore": outcome(storage::read("state.json"), |v| v.map(Value::from).unwrap_or(Value::Null)),
        "write": outcome(storage::write("dir/state.json", r#"{"n":1}"#), |()| Value::Null),
        "readAfter": outcome(storage::read("dir/state.json"), |v| v.map(Value::from).unwrap_or(Value::Null)),
        "list": outcome(storage::list("dir"), |entries| {
            entries.iter().map(|e| json!({ "name": e.name, "isDir": e.is_dir, "sizeBytes": e.size_bytes })).collect::<Vec<_>>().into()
        }),
        "escape": outcome(storage::write("../escape.txt", "x"), |()| Value::Null),
        "delete": outcome(storage::delete("dir"), |()| Value::Null),
        "readDeleted": outcome(storage::read("dir/state.json"), |v| v.map(Value::from).unwrap_or(Value::Null)),
    });

    let tool = input["tool"].as_str().unwrap_or("echo");
    let tools = json!({
        "available": outcome(native_tools::available(tool), Value::Bool),
        "undeclared": outcome(native_tools::run("not-declared", &native_tools::RunOptions {
            args: vec![], stdin: None, timeout_ms: None, output_base64: false,
        }), |_| Value::Null),
    });

    json!({
        "uuidLength": uuid.len(),
        "randomLength": random.len(),
        "permissions": permissions,
        "clock": clock,
        "frontmatter": frontmatter,
        "notes": notes,
        "storage": storage,
        "tools": tools,
    })
}

/// The Templates pattern: notes carrying a tag become a menu of
/// `createNoteFromNote` effects.
fn menu(input: &Value) -> Result<Value, String> {
    let tag = input["settings"]["tag"].as_str().unwrap_or("template");
    let all = notes::all().map_err(|e| format!("{e:?}"))?;
    let mut items: Vec<Value> = all
        .iter()
        .filter(|n| n.tags.iter().any(|t| t == tag))
        .map(|n| json!({ "label": n.title, "run": { "effect": "createNoteFromNote", "sourceNoteId": n.id } }))
        .collect();
    items.sort_by(|a, b| a["label"].as_str().cmp(&b["label"].as_str()));
    if items.is_empty() {
        return Ok(json!({ "effect": "toast", "message": "No template notes found." }));
    }
    Ok(json!({ "effect": "openMenu", "items": items }))
}

fn run_tool(input: &Value) -> Value {
    let options = native_tools::RunOptions {
        args: input["args"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        stdin: input["stdin"].as_str().map(String::from),
        timeout_ms: input["timeoutMs"].as_u64().map(|t| t as u32),
        output_base64: input["outputBase64"].as_bool().unwrap_or(false),
    };
    outcome(
        native_tools::run(input["tool"].as_str().unwrap_or("echo"), &options),
        |out| {
            json!({
                "statusCode": out.status_code,
                "stdout": out.stdout,
                "stdoutBase64": out.stdout_base64,
                "stderr": out.stderr,
                "timedOut": out.timed_out,
            })
        },
    )
}

impl Guest for Conformance {
    fn invoke(export: String, input: String) -> Result<String, String> {
        let parsed: Value =
            serde_json::from_str(&input).map_err(|e| format!("input is not JSON: {e}"))?;
        let value = match export.as_str() {
            "echo" => parsed,
            "counter" => {
                Value::from(CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1)
            }
            "report" => report(&parsed),
            "menu" => menu(&parsed)?,
            "runTool" => run_tool(&parsed),
            "fail" => return Err("boom".into()),
            "notJson" => return Ok("this is not json".into()),
            "bigOutput" => {
                let bytes = parsed["bytes"].as_u64().unwrap_or(0) as usize;
                Value::String("x".repeat(bytes))
            }
            "spin" => {
                let mut n: u64 = 0;
                loop {
                    n = n.wrapping_add(1);
                    std::hint::black_box(n);
                }
            }
            "grow" => {
                let mut held: Vec<Vec<u8>> = Vec::new();
                loop {
                    held.push(vec![1; 1024 * 1024]);
                    std::hint::black_box(&held);
                }
            }
            "panic" => panic!("conformance panic"),
            "toolLoop" => loop {
                let _ = native_tools::run(
                    parsed["tool"].as_str().unwrap_or("echo"),
                    &native_tools::RunOptions {
                        args: vec![],
                        stdin: None,
                        timeout_ms: Some(100),
                        output_base64: false,
                    },
                );
            },
            "randomTooMuch" => Value::from(runtime::random_bytes(1 << 20).len()),
            other => return Err(format!("unknown export {other}")),
        };
        Ok(value.to_string())
    }
}

export!(Conformance);
