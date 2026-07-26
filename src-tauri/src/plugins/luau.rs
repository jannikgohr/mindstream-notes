//! Sandboxed Luau execution for scripted (`runtime: "luau"`) plugins.
//!
//! This is the trust-critical core of the scripted-plugin tier. A plugin's
//! `.luau` script is *untrusted code*, so every invocation runs under four
//! independent guards:
//!
//!   1. **Fresh, isolated state** — one brand-new [`Lua`] per call, discarded
//!      after. Scripts can't accumulate or leak state across runs or plugins;
//!      any globals a script sets live only in that one isolated invocation.
//!   2. **Luau sandbox** — `sandbox(true)` runs the chunk against a read-only
//!      view of the shared globals (with `safeenv` optimizations), and Luau's
//!      stdlib is already curated: no `io`, no `os.execute`, no
//!      `package`/`require`, no `ffi` — the dangerous surface simply isn't there.
//!   3. **Memory cap** — `set_memory_limit` aborts a script that allocates past
//!      the budget instead of letting it exhaust the host.
//!   4. **Wall-clock deadline** — an `interrupt` hook fires on Luau back-edges /
//!      calls and aborts once the deadline passes, so a runaway loop can't hang.
//!
//! The host API (`ms.*`) is **permission-gated**: safe helpers are always
//! present, but any capability namespace is installed only when the plugin's
//! granted permissions include the matching capability (see [`install_host_api`]).
//! This maps the manifest `permissions` array onto exactly what a script can
//! reach — the same capability model the declarative tier uses.
//!
//! Note writes are deliberately *not* exposed to scripts: a Luau template
//! returns `{ title, body }` and the app performs the note creation, preserving
//! the "a plugin never writes notes itself" invariant of the declarative tier.

use std::fmt::Write as _;
use std::time::{Duration, Instant};

use mlua::{Lua, LuaSerdeExt, MultiValue, Table, Value, VmState};

use crate::error::{AppError, AppResult};

/// Resource bounds for one script invocation.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub memory_bytes: usize,
    pub timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        // Generous for template rendering (string building), tight enough that a
        // buggy or hostile script can't exhaust the host or hang the UI thread
        // it was dispatched from.
        Self {
            memory_bytes: 16 * 1024 * 1024,
            timeout: Duration::from_millis(500),
        }
    }
}

/// One script invocation request.
pub struct ScriptRequest {
    /// The `.luau` source to evaluate.
    pub source: String,
    /// A human name for the chunk, used in error messages (e.g. `"<id>/main.luau"`).
    pub chunk_name: String,
    /// The exported function to call. The script must evaluate to a table with
    /// this key (or to a bare function, which is used directly).
    pub export: String,
    /// Passed to the exported function as its single argument (a Luau table).
    pub input: serde_json::Value,
    /// The plugin's granted permissions — decides which `ms.*` namespaces exist.
    pub permissions: Vec<String>,
    pub limits: Limits,
}

fn err(msg: impl Into<String>) -> AppError {
    AppError::InvalidArg(msg.into())
}

fn map_lua(chunk: &str, e: mlua::Error) -> AppError {
    err(format!("luau ({chunk}): {e}"))
}

/// Run one script and return the exported function's result as JSON.
///
/// Constructs and tears down the whole VM inside this call, so it is safe to
/// dispatch onto a blocking worker (the VM never crosses a thread boundary).
pub fn run(req: ScriptRequest) -> AppResult<serde_json::Value> {
    let lua = Lua::new();
    lua.set_memory_limit(req.limits.memory_bytes)
        .map_err(|e| map_lua(&req.chunk_name, e))?;

    // Wall-clock deadline. The interrupt fires on back-edges/calls; returning an
    // error aborts the running script.
    let deadline = Instant::now() + req.limits.timeout;
    lua.set_interrupt(move |_| {
        if Instant::now() >= deadline {
            Err(mlua::Error::runtime("script exceeded its time budget"))
        } else {
            Ok(VmState::Continue)
        }
    });

    install_host_api(&lua, &req.permissions).map_err(|e| map_lua(&req.chunk_name, e))?;

    // Enter the sandbox AFTER installing the host API so `ms` is visible through
    // the read-only global view. Combined with the fresh-VM-per-call above, a
    // script's writes stay confined to its own throwaway invocation.
    lua.sandbox(true).map_err(|e| map_lua(&req.chunk_name, e))?;

    let input = lua
        .to_value(&req.input)
        .map_err(|e| map_lua(&req.chunk_name, e))?;

    let exported: Value = lua
        .load(&req.source)
        .set_name(&req.chunk_name)
        .eval()
        .map_err(|e| map_lua(&req.chunk_name, e))?;

    let func = resolve_export(&exported, &req.export).ok_or_else(|| {
        err(format!(
            "luau ({}): no exported function '{}'",
            req.chunk_name, req.export
        ))
    })?;

    let ret: Value = func
        .call(MultiValue::from_iter([input]))
        .map_err(|e| map_lua(&req.chunk_name, e))?;

    lua.from_value(ret).map_err(|e| map_lua(&req.chunk_name, e))
}

/// The exported function: `table[export]`, or a bare function returned directly.
fn resolve_export(exported: &Value, export: &str) -> Option<mlua::Function> {
    match exported {
        Value::Function(f) => Some(f.clone()),
        Value::Table(t) => match t.get::<Value>(export) {
            Ok(Value::Function(f)) => Some(f),
            _ => None,
        },
        _ => None,
    }
}

/// Install the `ms.*` host API. Safe, side-effect-free helpers are always
/// present; capability namespaces are gated on the plugin's granted permissions,
/// so a script can only reach what its manifest asked for.
fn install_host_api(lua: &Lua, permissions: &[String]) -> mlua::Result<()> {
    let ms = lua.create_table()?;

    // --- Always available (no permission required) ------------------------
    // Diagnostics: a script's log line, tagged, into the app log.
    ms.set(
        "log",
        lua.create_function(|_, msg: String| {
            log::info!("[luau plugin] {msg}");
            Ok(())
        })?,
    )?;
    // A fresh v4 UUID.
    ms.set(
        "uuid",
        lua.create_function(|_, ()| Ok(uuid::Uuid::new_v4().to_string()))?,
    )?;
    // Current instant as an RFC3339 string.
    ms.set(
        "now_iso",
        lua.create_function(|_, ()| Ok(chrono::Utc::now().to_rfc3339()))?,
    )?;
    // Today's local date as YYYY-MM-DD, with an optional integer day offset.
    ms.set(
        "today",
        lua.create_function(|_, offset_days: Option<i64>| {
            let date = chrono::Local::now().date_naive()
                + chrono::Duration::days(offset_days.unwrap_or(0));
            Ok(date.format("%Y-%m-%d").to_string())
        })?,
    )?;

    // --- Gated: templates.contribute → ms.template ------------------------
    if permissions.iter().any(|p| p == "templates.contribute") {
        let template = lua.create_table()?;
        // Serialize a table to a YAML frontmatter block — the single most useful
        // primitive for template scripts, and naturally scoped to templating.
        template.set(
            "frontmatter",
            lua.create_function(|lua, tbl: Table| {
                let json: serde_json::Value = lua.from_value(Value::Table(tbl))?;
                frontmatter(&json).map_err(mlua::Error::runtime)
            })?,
        )?;
        ms.set("template", template)?;
    }

    lua.globals().set("ms", ms)?;
    Ok(())
}

/// Serialize a JSON object to a `---`-delimited YAML frontmatter block. Supports
/// scalar values and arrays of scalars (one level) — enough for note metadata.
fn frontmatter(value: &serde_json::Value) -> Result<String, String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "ms.template.frontmatter expects a table".to_string())?;
    let mut out = String::from("---\n");
    for (key, val) in obj {
        match val {
            serde_json::Value::Array(items) => {
                let _ = writeln!(out, "{key}:");
                for item in items {
                    let _ = writeln!(out, "  - {}", yaml_scalar(item));
                }
            }
            other => {
                let _ = writeln!(out, "{key}: {}", yaml_scalar(other));
            }
        }
    }
    out.push_str("---\n");
    Ok(out)
}

/// A single YAML scalar. Strings are double-quoted + escaped (always valid);
/// numbers/bools render bare; null renders empty.
fn yaml_scalar(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => {
            let escaped = s
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('\n', "\\n");
            format!("\"{escaped}\"")
        }
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Null => String::new(),
        // Nested arrays/objects aren't supported at this level — render as JSON
        // so nothing is silently lost.
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(source: &str, export: &str, input: serde_json::Value, perms: &[&str]) -> ScriptRequest {
        ScriptRequest {
            source: source.to_string(),
            chunk_name: "test.luau".into(),
            export: export.into(),
            input,
            permissions: perms.iter().map(|s| s.to_string()).collect(),
            limits: Limits::default(),
        }
    }

    #[test]
    fn calls_exported_function_with_input() {
        let out = run(req(
            "return { render = function(ctx) return { sum = ctx.a + ctx.b } end }",
            "render",
            serde_json::json!({ "a": 2, "b": 3 }),
            &[],
        ))
        .unwrap();
        assert_eq!(out["sum"], serde_json::json!(5));
    }

    #[test]
    fn accepts_a_bare_returned_function() {
        let out = run(req(
            "return function(ctx) return { echo = ctx.msg } end",
            "whatever",
            serde_json::json!({ "msg": "hi" }),
            &[],
        ))
        .unwrap();
        assert_eq!(out["echo"], serde_json::json!("hi"));
    }

    #[test]
    fn missing_export_is_an_error() {
        let e = run(req(
            "return { other = function() end }",
            "render",
            serde_json::json!({}),
            &[],
        ));
        assert!(e.is_err());
    }

    #[test]
    fn enforces_the_wall_clock_deadline() {
        let mut r = req(
            "return { go = function() while true do end end }",
            "go",
            serde_json::json!({}),
            &[],
        );
        r.limits.timeout = Duration::from_millis(100);
        let started = Instant::now();
        let out = run(r);
        assert!(out.is_err(), "infinite loop must be aborted");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "aborted promptly"
        );
    }

    #[test]
    fn enforces_the_memory_limit() {
        let mut r = req(
            "return { go = function() local t = {} for i = 1, 5000000 do t[i] = i end return #t end }",
            "go",
            serde_json::json!({}),
            &[],
        );
        r.limits.memory_bytes = 1024 * 1024; // 1 MiB
        r.limits.timeout = Duration::from_secs(10); // isolate memory from time
        assert!(run(r).is_err(), "runaway allocation must be rejected");
    }

    #[test]
    fn runs_are_isolated() {
        // A global set during one run must not leak into the next (fresh VM).
        let set = "return { go = function() stashed = 42; return { v = stashed } end }";
        let read = "return { go = function() return { v = stashed } end }";
        let first = run(req(set, "go", serde_json::json!({}), &[])).unwrap();
        assert_eq!(first["v"], serde_json::json!(42));
        let second = run(req(read, "go", serde_json::json!({}), &[])).unwrap();
        assert!(second["v"].is_null(), "state must not carry across runs");
    }

    #[test]
    fn curated_stdlib_has_no_process_escape() {
        let out = run(req(
            "return { go = function() return { exec = type(os.execute), io = type(io) } end }",
            "go",
            serde_json::json!({}),
            &[],
        ))
        .unwrap();
        assert_eq!(out["exec"], serde_json::json!("nil"));
        assert_eq!(out["io"], serde_json::json!("nil"));
    }

    #[test]
    fn host_api_is_permission_gated() {
        let probe = "return { go = function() return { hasTemplate = ms.template ~= nil } end }";
        let without = run(req(probe, "go", serde_json::json!({}), &[])).unwrap();
        assert_eq!(without["hasTemplate"], serde_json::json!(false));
        let with = run(req(
            probe,
            "go",
            serde_json::json!({}),
            &["templates.contribute"],
        ))
        .unwrap();
        assert_eq!(with["hasTemplate"], serde_json::json!(true));
    }

    #[test]
    fn safe_helpers_are_always_present() {
        let out = run(req(
            "return { go = function() return { u = #ms.uuid(), d = ms.today() } end }",
            "go",
            serde_json::json!({}),
            &[],
        ))
        .unwrap();
        assert_eq!(out["u"], serde_json::json!(36)); // uuid v4 string length
        assert_eq!(out["d"].as_str().unwrap().len(), 10); // YYYY-MM-DD
    }

    #[test]
    fn frontmatter_helper_builds_yaml() {
        let out = run(req(
            r#"return { go = function()
                 return { fm = ms.template.frontmatter({ title = "Hi", tags = { "a", "b" } }) }
               end }"#,
            "go",
            serde_json::json!({}),
            &["templates.contribute"],
        ))
        .unwrap();
        let fm = out["fm"].as_str().unwrap();
        assert!(fm.starts_with("---\n"));
        assert!(fm.contains("title: \"Hi\""));
        assert!(fm.contains("  - \"a\""));
    }
}
