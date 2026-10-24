//! Sandboxed Luau execution for scripted (`runtime: "luau"`) plugins.
//!
//! A plugin's `.luau` script is untrusted code, so every invocation runs under
//! four independent guards:
//!
//!   1. **Fresh, isolated state**: one brand-new [`Lua`] per call, discarded
//!      after. Scripts can't accumulate or leak state across runs or plugins.
//!   2. **Luau sandbox**: `sandbox(true)` runs the chunk against a read-only
//!      view of the shared globals, and Luau's stdlib is already curated: no
//!      `io`, no `os.execute`, no `package`, no `ffi`. The one `require` a
//!      script sees is our plugin-scoped shim, which resolves only the
//!      plugin's own bundled `.luau` modules (see [`install_require`]).
//!   3. **Memory cap**: `set_memory_limit` aborts a script that allocates past
//!      the budget instead of letting it exhaust the host.
//!   4. **Deadline and cancellation**: an `interrupt` hook fires on Luau
//!      back-edges and calls and asks the shared [`HostContext`] whether the
//!      call has to stop, so a runaway loop can't hang and a disabled plugin
//!      stops mid-call.
//!
//! The `ms.*` table is a thin adapter. Every capability behind it, with its
//! permission check, path containment and size limits, lives in
//! [`mindstream_plugin_runtime::host`], the same code the Wasm runtime calls.
//! A namespace is also only installed when its permission is granted, so
//! `ms.notes == nil` for a plugin without `notes.read`; the host checks again
//! on every call regardless.
//!
//! Note writes are deliberately *not* exposed: a template returns
//! `{ title, body }` and the app performs the note creation.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use mindstream_plugin_runtime::cancel::CancelToken;
use mindstream_plugin_runtime::dates::{DateInput, TimeUnit};
use mindstream_plugin_runtime::host::{
    CallSetup, HostContext, LogLevel, ToolRunOptions, PERM_NATIVE_TOOLS, PERM_NOTES_READ,
    PERM_STORAGE_READ, PERM_STORAGE_WRITE,
};
use mindstream_plugin_runtime::limits::{self, Limits};
use mindstream_plugin_runtime::HostError;
use mlua::{Lua, LuaSerdeExt, MultiValue, Table, Value, VmState};

pub use mindstream_plugin_runtime::host::NoteMeta;

use crate::error::{AppError, AppResult};

/// One script invocation request.
pub struct ScriptRequest {
    /// The plugin id, used to tag log lines.
    pub plugin_id: String,
    /// The `.luau` source to evaluate.
    pub source: String,
    /// A human name for the chunk, used in error messages (e.g. `"<id>/main.luau"`).
    pub chunk_name: String,
    /// The exported function to call. The script must evaluate to a table with
    /// this key (or to a bare function, which is used directly).
    pub export: String,
    /// Passed to the exported function as its single argument (a Luau table).
    pub input: serde_json::Value,
    /// The plugin's granted permissions: decides which `ms.*` namespaces exist.
    pub permissions: Vec<String>,
    /// Read-only note snapshot exposed via `ms.notes` when `notes.read` is
    /// granted. Built by the caller before the script runs; empty otherwise.
    pub notes: Vec<NoteMeta>,
    /// Declared native tools resolved to their PATH binary. `None` = declared
    /// but not found (always the case on mobile).
    pub native_tools: HashMap<String, Option<PathBuf>>,
    /// The plugin's isolated data directory: the working directory for native
    /// tool runs and the root `ms.storage` reads and writes under.
    pub data_root: Option<PathBuf>,
    /// The plugin's other `.luau` files as `module path (no extension) -> source`,
    /// for the plugin-scoped `require`.
    pub modules: HashMap<String, String>,
    pub limits: Limits,
    pub cancel: CancelToken,
}

fn err(msg: impl Into<String>) -> AppError {
    AppError::InvalidArg(msg.into())
}

fn map_lua(chunk: &str, e: mlua::Error) -> AppError {
    err(format!("luau ({chunk}): {e}"))
}

/// A host refusal as a Luau error. Scripts can `pcall` these, but the
/// interrupt hook raises the budget and cancellation ones again at the next
/// back-edge, so catching them does not keep a call alive.
fn lua_err(e: HostError) -> mlua::Error {
    mlua::Error::runtime(e.to_string())
}

/// Run one script and return the exported function's result as JSON.
///
/// Constructs and tears down the whole VM inside this call, so it is safe to
/// dispatch onto a blocking worker (the VM never crosses a thread boundary).
pub fn run(req: ScriptRequest) -> AppResult<serde_json::Value> {
    run_with_native_budget(req, limits::NATIVE_ALLOWANCE)
}

fn run_with_native_budget(
    req: ScriptRequest,
    native_allowance: Duration,
) -> AppResult<serde_json::Value> {
    let lua = Lua::new();
    lua.set_memory_limit(req.limits.memory_bytes)
        .map_err(|e| map_lua(&req.chunk_name, e))?;

    let host = Rc::new(HostContext::new(
        CallSetup {
            plugin_id: req.plugin_id,
            permissions: req.permissions,
            notes: req.notes,
            native_tools: req.native_tools,
            data_root: req.data_root,
            cancel: req.cancel,
        },
        req.limits,
        native_allowance,
    ));
    host.check()?;
    let interrupt_host = host.clone();
    lua.set_interrupt(move |_| {
        interrupt_host.check().map_err(lua_err)?;
        Ok(VmState::Continue)
    });

    install_host_api(&lua, host.clone()).map_err(|e| map_lua(&req.chunk_name, e))?;
    install_require(&lua, req.modules).map_err(|e| map_lua(&req.chunk_name, e))?;

    // Enter the sandbox AFTER installing the host API so `ms` is visible through
    // the read-only global view. Combined with the fresh VM per call, a
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

    host.check()
        .map_err(|e| map_lua(&req.chunk_name, lua_err(e)))?;
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

/// Install the `ms.*` host API.
///
/// Safe, side-effect-free helpers are always present. A capability namespace
/// is installed only when the plugin holds its permission, so a script can
/// feature-detect with `ms.notes ~= nil`.
fn install_host_api(lua: &Lua, host: Rc<HostContext>) -> mlua::Result<()> {
    let ms = lua.create_table()?;

    let h = host.clone();
    ms.set(
        "log",
        lua.create_function(move |_, msg: String| {
            h.log(LogLevel::Info, &msg);
            Ok(())
        })?,
    )?;
    let h = host.clone();
    ms.set("uuid", lua.create_function(move |_, ()| Ok(h.uuid()))?)?;
    ms.set("date", date_module(lua, host.clone())?)?;
    ms.set("json", json_module(lua)?)?;
    ms.set("md", md_module(lua, host.clone())?)?;

    if host.granted(PERM_NOTES_READ) {
        ms.set("notes", notes_module(lua, host.clone())?)?;
    }
    if host.granted(PERM_NATIVE_TOOLS) {
        ms.set("nativeTools", native_tools_module(lua, host.clone())?)?;
    }
    // Present when either half is granted; the functions are added per grant,
    // so a read-only plugin gets `read`/`list` and no `write`.
    let may_read = host.granted(PERM_STORAGE_READ);
    let may_write = host.granted(PERM_STORAGE_WRITE);
    if may_read || may_write {
        ms.set("storage", storage_module(lua, host, may_read, may_write)?)?;
    }

    lua.globals().set("ms", ms)?;
    Ok(())
}

/// `ms.nativeTools`: availability of, and runs of, the plugin's *declared*
/// PATH binaries. The host resolved them before the script started, so a
/// script can only reach binaries its manifest declared.
fn native_tools_module(lua: &Lua, host: Rc<HostContext>) -> mlua::Result<Table> {
    let table = lua.create_table()?;
    let h = host.clone();
    table.set(
        "available",
        lua.create_function(move |_, id: String| h.tool_available(&id).map_err(lua_err))?,
    )?;
    table.set(
        "run",
        lua.create_function(move |lua, (id, opts): (String, Option<Table>)| {
            let options = match opts {
                Some(t) => ToolRunOptions {
                    args: match t.get::<Value>("args")? {
                        Value::Table(list) => list
                            .sequence_values::<String>()
                            .collect::<mlua::Result<Vec<_>>>()?,
                        Value::Nil => Vec::new(),
                        _ => {
                            return Err(mlua::Error::runtime(
                                "ms.nativeTools.run: args must be an array of strings",
                            ))
                        }
                    },
                    stdin: t.get::<Option<String>>("stdin")?,
                    timeout_ms: t.get::<Option<u64>>("timeoutMs")?,
                    output_base64: t.get::<Option<bool>>("outputBase64")?.unwrap_or(false),
                },
                None => ToolRunOptions::default(),
            };
            let output = host.tool_run(&id, options).map_err(lua_err)?;
            let result = lua.create_table()?;
            result.set("statusCode", output.status_code)?;
            result.set("stderr", output.stderr)?;
            result.set("timedOut", output.timed_out)?;
            result.set("stdout", output.stdout)?;
            if let Some(encoded) = output.stdout_base64 {
                result.set("stdoutBase64", encoded)?;
            }
            Ok(result)
        })?,
    )?;
    Ok(table)
}

/// Install a **plugin-scoped `require`** so a script can split itself across
/// several `.luau` files.
///
/// `modules` is the plugin's own `.luau` files (keyed by module path without the
/// extension); `require(name)` resolves *only* these, never the filesystem,
/// network, or another plugin, so it can't reach outside the already-signed
/// plugin bundle. Each module is evaluated at most once and its result cached
/// (module semantics), and a cyclic `require` is rejected rather than looping.
fn install_require(lua: &Lua, modules: HashMap<String, String>) -> mlua::Result<()> {
    let modules = Rc::new(modules);
    let cache: Rc<RefCell<HashMap<String, Value>>> = Rc::new(RefCell::new(HashMap::new()));
    let loading: Rc<RefCell<HashSet<String>>> = Rc::new(RefCell::new(HashSet::new()));

    let require = lua.create_function(move |lua, name: String| {
        let key = normalize_module(&name)
            .ok_or_else(|| mlua::Error::runtime(format!("require: invalid module '{name}'")))?;
        if let Some(cached) = cache.borrow().get(&key) {
            return Ok(cached.clone());
        }
        let source = modules
            .get(&key)
            .ok_or_else(|| mlua::Error::runtime(format!("require: module '{key}' not found")))?;
        if !loading.borrow_mut().insert(key.clone()) {
            return Err(mlua::Error::runtime(format!("require: cyclic '{key}'")));
        }
        let result = lua.load(source.as_str()).set_name(&key).eval::<Value>();
        loading.borrow_mut().remove(&key);
        let value = result?;
        cache.borrow_mut().insert(key, value.clone());
        Ok(value)
    })?;
    lua.globals().set("require", require)?;
    Ok(())
}

/// Normalise a `require` argument to a module key, or `None` if it escapes the
/// plugin. Strips a leading `./` and a trailing `.luau`; rejects `..`, absolute
/// paths, and backslashes so a module name can only name a sibling file.
fn normalize_module(name: &str) -> Option<String> {
    let name = name.strip_prefix("./").unwrap_or(name);
    if name.is_empty() || name.starts_with('/') || name.contains("..") || name.contains('\\') {
        return None;
    }
    Some(name.strip_suffix(".luau").unwrap_or(name).to_string())
}

/// `ms.storage`: the plugin's own data directory. Gated on
/// `pluginStorage.read` / `pluginStorage.write`; containment and size limits
/// are the host's.
fn storage_module(
    lua: &Lua,
    host: Rc<HostContext>,
    may_read: bool,
    may_write: bool,
) -> mlua::Result<Table> {
    let table = lua.create_table()?;
    if may_read {
        let h = host.clone();
        table.set(
            "read",
            lua.create_function(move |_, rel: String| h.storage_read(&rel).map_err(lua_err))?,
        )?;
        let h = host.clone();
        table.set(
            "list",
            lua.create_function(move |lua, rel: Option<String>| {
                let entries = h
                    .storage_list(rel.as_deref().unwrap_or(""))
                    .map_err(lua_err)?;
                let out = lua.create_table()?;
                for (i, entry) in entries.into_iter().enumerate() {
                    let item = lua.create_table()?;
                    item.set("name", entry.name)?;
                    item.set("isDir", entry.is_dir)?;
                    item.set("sizeBytes", entry.size_bytes)?;
                    out.set(i + 1, item)?;
                }
                Ok(out)
            })?,
        )?;
    }
    if may_write {
        let h = host.clone();
        table.set(
            "write",
            lua.create_function(move |_, (rel, contents): (String, String)| {
                h.storage_write(&rel, &contents).map_err(lua_err)
            })?,
        )?;
        table.set(
            "delete",
            lua.create_function(move |_, rel: String| host.storage_delete(&rel).map_err(lua_err))?,
        )?;
    }
    Ok(table)
}

/// A Lua date argument: an RFC3339 string or epoch seconds.
fn date_input(value: &Value) -> Option<DateInput> {
    match value {
        Value::String(s) => Some(DateInput::Rfc3339(s.to_str().ok()?.to_string())),
        Value::Integer(secs) => Some(DateInput::EpochSeconds(*secs as i64)),
        Value::Number(secs) => Some(DateInput::EpochSeconds(*secs as i64)),
        _ => None,
    }
}

/// `ms.date`: current time, formatting and arithmetic in local time, with the
/// same moment-style tokens as the frontend template engine.
fn date_module(lua: &Lua, host: Rc<HostContext>) -> mlua::Result<Table> {
    let date = lua.create_table()?;
    let h = host.clone();
    date.set(
        "now",
        lua.create_function(
            move |_, (fmt, offset, locale): (Option<String>, Option<i64>, Option<String>)| {
                h.date_now(
                    fmt.as_deref().unwrap_or("YYYY-MM-DD"),
                    offset.unwrap_or(0),
                    locale.as_deref().unwrap_or("en"),
                )
                .map_err(lua_err)
            },
        )?,
    )?;
    let h = host.clone();
    date.set(
        "format",
        lua.create_function(
            move |_, (input, fmt, locale): (Value, Option<String>, Option<String>)| {
                let input = date_input(&input).ok_or_else(|| {
                    mlua::Error::runtime(
                        "ms.date.format: input must be an RFC3339 string or epoch seconds",
                    )
                })?;
                h.date_format(
                    &input,
                    fmt.as_deref().unwrap_or("YYYY-MM-DD"),
                    locale.as_deref().unwrap_or("en"),
                )
                .map_err(lua_err)
            },
        )?,
    )?;
    date.set(
        "add",
        lua.create_function(move |_, (input, amount, unit): (Value, i64, String)| {
            let input = date_input(&input).ok_or_else(|| {
                mlua::Error::runtime(
                    "ms.date.add: input must be an RFC3339 string or epoch seconds",
                )
            })?;
            let unit = TimeUnit::parse(&unit).ok_or_else(|| {
                mlua::Error::runtime(format!("ms.date.add: unknown unit '{unit}'"))
            })?;
            host.date_add(&input, amount, unit).map_err(lua_err)
        })?,
    )?;
    Ok(date)
}

/// `ms.json`: encode a Lua value to a JSON string and back.
fn json_module(lua: &Lua) -> mlua::Result<Table> {
    let json = lua.create_table()?;
    json.set(
        "encode",
        lua.create_function(|lua, value: Value| {
            let v: serde_json::Value = lua.from_value(value)?;
            serde_json::to_string(&v).map_err(mlua::Error::runtime)
        })?,
    )?;
    json.set(
        "decode",
        lua.create_function(|lua, s: String| {
            let v: serde_json::Value = serde_json::from_str(&s).map_err(mlua::Error::runtime)?;
            lua.to_value(&v)
        })?,
    )?;
    Ok(json)
}

/// `ms.md`: markdown helpers.
fn md_module(lua: &Lua, host: Rc<HostContext>) -> mlua::Result<Table> {
    let md = lua.create_table()?;
    md.set(
        "frontmatter",
        lua.create_function(move |lua, tbl: Table| {
            let json: serde_json::Value = lua.from_value(Value::Table(tbl))?;
            host.frontmatter(&json).map_err(lua_err)
        })?,
    )?;
    Ok(md)
}

/// `ms.notes`: read-only vault metadata from the snapshot the caller built.
fn notes_module(lua: &Lua, host: Rc<HostContext>) -> mlua::Result<Table> {
    let ms_notes = lua.create_table()?;
    let h = host.clone();
    ms_notes.set(
        "all",
        lua.create_function(move |lua, ()| lua.to_value(h.notes_all().map_err(lua_err)?))?,
    )?;
    ms_notes.set(
        "get",
        lua.create_function(move |lua, id: String| {
            match host.notes_get(&id).map_err(lua_err)? {
                Some(note) => lua.to_value(note),
                None => Ok(Value::Nil),
            }
        })?,
    )?;
    Ok(ms_notes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mindstream_plugin_runtime::host::MAX_STORAGE_FILE_BYTES;
    use std::time::Instant;

    fn req(source: &str, export: &str, input: serde_json::Value, perms: &[&str]) -> ScriptRequest {
        ScriptRequest {
            plugin_id: "com.test.luau".into(),
            source: source.to_string(),
            chunk_name: "test.luau".into(),
            export: export.into(),
            input,
            permissions: perms.iter().map(|s| s.to_string()).collect(),
            notes: Vec::new(),
            native_tools: HashMap::new(),
            data_root: None,
            modules: HashMap::new(),
            limits: limits::LUAU.resolve(None, None),
            cancel: CancelToken::new(),
        }
    }

    #[test]
    fn typst_source_export_does_not_require_native_tools() {
        let source = include_str!("../../../plugin-sdk/examples/legacy-luau/typst/main.luau");
        for body in ["", "= Café\n"] {
            let out = run(req(
                source,
                "exportDocument",
                serde_json::json!({"format": "typ", "body": body}),
                &[],
            ))
            .unwrap();
            assert_eq!(out["file"]["text"], body);
            assert_eq!(out["file"]["mime"], "text/plain");
        }
    }

    #[test]
    fn typst_image_export_requests_the_selected_page() {
        let source = format!(
            r#"local ms = {{ nativeTools = {{ run = function(_, opts) return {{ statusCode = 0, stdoutBase64 = opts.args[3] .. ":" .. opts.args[5], stderr = "" }} end }} }}
{}"#,
            include_str!("../../../plugin-sdk/examples/legacy-luau/typst/main.luau")
        );
        for (format, mime) in [("svg", "image/svg+xml"), ("png", "image/png")] {
            let out = run(req(
                &source,
                "exportDocument",
                serde_json::json!({"format": format, "page": 2, "body": "= Test"}),
                &[],
            ))
            .unwrap();
            assert_eq!(out["file"]["mime"], mime);
            assert_eq!(out["file"]["dataBase64"], format!("{format}:2"));
        }
    }

    /// A scratch data root plus a request wired to it, for the ms.storage tests.
    fn storage_req(source: &str, perms: &[&str], root: &std::path::Path) -> ScriptRequest {
        let mut r = req(source, "go", serde_json::json!({}), perms);
        r.data_root = Some(root.to_path_buf());
        r
    }

    fn storage_tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ms-storage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn storage_is_absent_without_either_permission() {
        let root = storage_tmp();
        let out = run(storage_req(
            "return { go = function() return { has = ms.storage ~= nil } end }",
            &[],
            &root,
        ))
        .unwrap();
        assert_eq!(out["has"], serde_json::json!(false));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn storage_round_trips_a_value() {
        let root = storage_tmp();
        let out = run(storage_req(
            r#"return { go = function()
                local before = ms.storage.read("state.json")
                ms.storage.write("state.json", '{"seen":1}')
                return { before = before, after = ms.storage.read("state.json") }
            end }"#,
            &["pluginStorage.read", "pluginStorage.write"],
            &root,
        ))
        .unwrap();
        // Absent reads as nil rather than erroring: "have I stored this yet?"
        // is the common first call.
        assert!(out["before"].is_null());
        assert_eq!(out["after"], serde_json::json!(r#"{"seen":1}"#));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn storage_write_is_refused_with_only_read() {
        let root = storage_tmp();
        let out = run(storage_req(
            r#"return { go = function()
                return { canRead = ms.storage.read ~= nil, canWrite = ms.storage.write ~= nil }
            end }"#,
            &["pluginStorage.read"],
            &root,
        ))
        .unwrap();
        assert_eq!(out["canRead"], serde_json::json!(true));
        assert_eq!(out["canWrite"], serde_json::json!(false));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn storage_rejects_traversal_out_of_the_data_root() {
        let root = storage_tmp();
        for path in ["../escape.txt", "/etc/passwd", "a/../../b.txt"] {
            let source = format!(
                r#"return {{ go = function() ms.storage.write("{path}", "x") return {{}} end }}"#
            );
            let err = run(storage_req(
                &source,
                &["pluginStorage.read", "pluginStorage.write"],
                &root,
            ))
            .expect_err("traversal must be refused");
            assert!(
                err.to_string().contains("unsafe plugin storage path"),
                "unexpected error for {path}: {err}"
            );
        }
        // Nothing escaped: the parent still holds only the root we made.
        assert!(!root.parent().unwrap().join("escape.txt").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    #[cfg_attr(windows, ignore = "creating a symlink needs elevation on Windows")]
    fn storage_write_refuses_to_follow_a_symlink_out_of_the_data_root() {
        // Containment-checking only the parent directory is not enough: if the
        // target path is itself a symlink, `fs::write` follows it and lands
        // outside the plugin's data root entirely.
        let root = storage_tmp();
        let outside = storage_tmp();
        let victim = outside.join("victim.txt");
        std::fs::write(&victim, "original").unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink(&victim, root.join("escape.txt")).unwrap();

        let err = run(storage_req(
            r#"return { go = function() ms.storage.write("escape.txt", "pwned") return {} end }"#,
            &["pluginStorage.read", "pluginStorage.write"],
            &root,
        ))
        .expect_err("a symlinked target must be refused");
        assert!(err.to_string().contains("symlink"), "{err}");
        assert_eq!(
            std::fs::read_to_string(&victim).unwrap(),
            "original",
            "the file outside the data root is untouched"
        );

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn storage_lists_and_deletes() {
        let root = storage_tmp();
        let out = run(storage_req(
            r#"return { go = function()
                ms.storage.write("b.txt", "second")
                ms.storage.write("a.txt", "first")
                local listed = ms.storage.list()
                ms.storage.delete("a.txt")
                return { listed = listed, afterDelete = ms.storage.read("a.txt"), kept = ms.storage.read("b.txt") }
            end }"#,
            &["pluginStorage.read", "pluginStorage.write"],
            &root,
        ))
        .unwrap();
        let listed = out["listed"].as_array().unwrap();
        assert_eq!(listed.len(), 2);
        // Sorted, so a script rendering the list does not see it reshuffle.
        assert_eq!(listed[0]["name"], serde_json::json!("a.txt"));
        assert_eq!(listed[0]["isDir"], serde_json::json!(false));
        assert_eq!(listed[0]["sizeBytes"], serde_json::json!(5));
        assert!(out["afterDelete"].is_null());
        assert_eq!(out["kept"], serde_json::json!("second"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn storage_lists_a_missing_directory_as_empty() {
        let root = storage_tmp();
        let out = run(storage_req(
            r#"return { go = function() return { listed = ms.storage.list("missing") } end }"#,
            &["pluginStorage.read"],
            &root,
        ))
        .unwrap();
        assert_eq!(out["listed"], serde_json::json!({}));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn storage_refuses_files_over_the_size_limit() {
        let root = storage_tmp();
        std::fs::write(
            root.join("large.txt"),
            vec![b'x'; MAX_STORAGE_FILE_BYTES + 1],
        )
        .unwrap();
        let err = run(storage_req(
            r#"return { go = function() ms.storage.read("large.txt") return {} end }"#,
            &["pluginStorage.read"],
            &root,
        ))
        .expect_err("an oversized stored file must not enter the runtime");
        assert!(err.to_string().contains("is larger than"), "{err}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn storage_refuses_writes_over_the_size_limit() {
        let root = storage_tmp();
        let mut request = storage_req(
            r#"return { go = function(ctx) ms.storage.write("large.txt", ctx.contents) return {} end }"#,
            &["pluginStorage.write"],
            &root,
        );
        request.input = serde_json::json!({ "contents": "x".repeat(MAX_STORAGE_FILE_BYTES + 1) });
        let err = run(request).expect_err("an oversized value must not be written");
        assert!(err.to_string().contains("exceeds"), "{err}");
        assert!(!root.join("large.txt").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn storage_without_a_data_dir_fails_loudly() {
        // The namespace exists so a script can call it; every call errors
        // rather than silently doing nothing.
        let mut r = req(
            r#"return { go = function() ms.storage.write("x", "y") return {} end }"#,
            "go",
            serde_json::json!({}),
            &["pluginStorage.write"],
        );
        r.data_root = None;
        let err = run(r).expect_err("no data dir must not silently succeed");
        assert!(err.to_string().contains("no data directory"));
    }

    fn note(id: &str, title: &str, tags: &[&str]) -> NoteMeta {
        NoteMeta {
            id: id.into(),
            title: title.into(),
            tags: tags.iter().map(|s| s.to_string()).collect(),
            kind: "markdown".into(),
            folder_id: None,
            folder_path: String::new(),
            created: "2026-07-26T00:00:00Z".into(),
            modified: "2026-07-26T00:00:00Z".into(),
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
    fn native_tool_loop_stops_at_the_invocation_deadline() {
        let mut request = req(
            "return { go = function() while true do pcall(function() ms.nativeTools.run('exit', { args = {'/c', 'exit', '0'} }) end) end end }",
            "go",
            serde_json::json!({}),
            &["nativeTools.runDeclared"],
        );
        #[cfg(windows)]
        let binary = PathBuf::from(std::env::var_os("COMSPEC").unwrap());
        #[cfg(not(windows))]
        let binary = PathBuf::from("/usr/bin/true");
        request.native_tools.insert("exit".into(), Some(binary));
        let root = storage_tmp();
        request.data_root = Some(root.clone());
        request.limits.timeout = Duration::from_millis(100);
        let started = Instant::now();
        let result = run_with_native_budget(request, Duration::from_millis(150));
        assert!(result.unwrap_err().to_string().contains("time budget"));
        assert!(started.elapsed() < Duration::from_secs(5));
        std::fs::remove_dir_all(root).ok();
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
    fn native_tools_absent_without_permission() {
        let out = run(req(
            "return { go = function() return { present = ms.nativeTools ~= nil } end }",
            "go",
            serde_json::json!({}),
            &[],
        ))
        .unwrap();
        assert_eq!(out["present"], serde_json::json!(false));
    }

    #[test]
    fn native_tools_available_reflects_resolved_map() {
        let mut r = req(
            "return { go = function() return { \
                typst = ms.nativeTools.available('typst'), \
                ghost = ms.nativeTools.available('ghost') \
            } end }",
            "go",
            serde_json::json!({}),
            &["nativeTools.runDeclared"],
        );
        // Declared + resolved vs declared-but-missing.
        r.native_tools
            .insert("typst".into(), Some(PathBuf::from("/usr/bin/typst")));
        r.native_tools.insert("ghost".into(), None);
        let out = run(r).unwrap();
        assert_eq!(out["typst"], serde_json::json!(true));
        assert_eq!(out["ghost"], serde_json::json!(false));
    }

    #[test]
    fn native_tools_run_rejects_unavailable_tool() {
        let mut r = req(
            "return { go = function() return ms.nativeTools.run('ghost', {}) end }",
            "go",
            serde_json::json!({}),
            &["nativeTools.runDeclared"],
        );
        r.native_tools.insert("ghost".into(), None);
        assert!(run(r).is_err(), "running an unresolved tool must error");
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
    fn ms_notes_is_gated_on_notes_read() {
        let probe = "return { go = function() return { has = ms.notes ~= nil } end }";
        let without = run(req(probe, "go", serde_json::json!({}), &[])).unwrap();
        assert_eq!(without["has"], serde_json::json!(false));
        let with = run(req(probe, "go", serde_json::json!({}), &["notes.read"])).unwrap();
        assert_eq!(with["has"], serde_json::json!(true));
    }

    #[test]
    fn ms_notes_reads_the_snapshot() {
        let mut r = req(
            r#"return { go = function()
                 local n = ms.notes.get("b")
                 return { count = #ms.notes.all(), title = n and n.title or nil }
               end }"#,
            "go",
            serde_json::json!({}),
            &["notes.read"],
        );
        r.notes = vec![note("a", "Alpha", &["x"]), note("b", "Beta", &["y"])];
        let out = run(r).unwrap();
        assert_eq!(out["count"], serde_json::json!(2));
        assert_eq!(out["title"], serde_json::json!("Beta"));
    }

    #[test]
    fn safe_helpers_are_always_present() {
        let out = run(req(
            "return { go = function() return { u = #ms.uuid(), d = ms.date.now() } end }",
            "go",
            serde_json::json!({}),
            &[],
        ))
        .unwrap();
        assert_eq!(out["u"], serde_json::json!(36)); // uuid v4 string length
        assert_eq!(out["d"].as_str().unwrap().len(), 10); // YYYY-MM-DD
    }

    #[test]
    fn ms_date_formats_and_offsets() {
        let out = run(req(
            r#"return { go = function()
                 local fmt = ms.date.format("2026-07-25T14:05:09Z", "YYYY/MM/DD")
                 local plus = ms.date.format(ms.date.add("2026-07-25T00:00:00Z", 1, "month"), "YYYY-MM-DD")
                 return { fmt = fmt, plus = plus }
               end }"#,
            "go",
            serde_json::json!({}),
            &[],
        ))
        .unwrap();
        // Local timezone may shift the day, so assert the stable parts.
        assert!(out["fmt"].as_str().unwrap().starts_with("2026/07/2"));
        assert_eq!(out["plus"], serde_json::json!("2026-08-25"));
    }

    #[test]
    fn ms_json_round_trips() {
        let out = run(req(
            r#"return { go = function()
                 local decoded = ms.json.decode('{"n":3,"list":[1,2]}')
                 return { n = decoded.n, encoded = ms.json.encode({ a = 1 }) }
               end }"#,
            "go",
            serde_json::json!({}),
            &[],
        ))
        .unwrap();
        assert_eq!(out["n"], serde_json::json!(3));
        assert_eq!(out["encoded"], serde_json::json!("{\"a\":1}"));
    }

    #[test]
    fn frontmatter_helper_builds_yaml() {
        let out = run(req(
            r#"return { go = function()
                 return { fm = ms.md.frontmatter({ title = "Hi", tags = { "a", "b" } }) }
               end }"#,
            "go",
            serde_json::json!({}),
            &[],
        ))
        .unwrap();
        let fm = out["fm"].as_str().unwrap();
        assert!(fm.starts_with("---\n"));
        assert!(fm.contains("title: \"Hi\""));
        assert!(fm.contains("  - \"a\""));
    }

    #[test]
    fn script_builds_an_open_menu_from_notes_and_ctx() {
        // The pattern a toolbar button uses: filter `ms.notes` by a setting from
        // `ctx`, and return an `openMenu` effect of `createNoteFromNote` items.
        let mut r = req(
            r#"return { newFromTemplate = function(ctx)
                 local items = {}
                 for _, n in ipairs(ms.notes.all()) do
                   if n.tags[1] == ctx.settings.tag then
                     items[#items + 1] = {
                       label = n.title,
                       run = { effect = "createNoteFromNote", sourceNoteId = n.id },
                     }
                   end
                 end
                 return { effect = "openMenu", items = items }
               end }"#,
            "newFromTemplate",
            serde_json::json!({ "settings": { "tag": "tpl" } }),
            &["notes.read"],
        );
        r.notes = vec![note("a", "Alpha", &["tpl"]), note("b", "Beta", &["x"])];
        let out = run(r).unwrap();
        assert_eq!(out["effect"], serde_json::json!("openMenu"));
        assert_eq!(out["items"].as_array().unwrap().len(), 1);
        assert_eq!(out["items"][0]["label"], serde_json::json!("Alpha"));
        assert_eq!(
            out["items"][0]["run"]["effect"],
            serde_json::json!("createNoteFromNote")
        );
    }

    #[test]
    fn require_loads_a_sibling_module_and_caches_it() {
        let mut r = req(
            // Requiring the same module twice returns the identical cached table.
            r#"local a = require("lib/util")
               local b = require("lib/util")
               return { go = function() return { v = a.double(21), same = a == b } end }"#,
            "go",
            serde_json::json!({}),
            &[],
        );
        r.modules.insert(
            "lib/util".into(),
            "return { double = function(x) return x * 2 end }".into(),
        );
        let out = run(r).unwrap();
        assert_eq!(out["v"], serde_json::json!(42));
        assert_eq!(out["same"], serde_json::json!(true)); // evaluated once, cached
    }

    #[test]
    fn require_rejects_escaping_and_unknown_modules() {
        // A traversal name and an unknown module both error (caught by pcall).
        let probe = r#"return { go = function(name)
             local ok = pcall(function() return require(name) end)
             return { ok = ok }
           end }"#;
        for name in ["../secret", "nope", "/etc/passwd"] {
            let out = run(req(probe, "go", serde_json::json!(name), &[])).unwrap();
            assert_eq!(out["ok"], serde_json::json!(false), "require('{name}')");
        }
    }

    #[test]
    fn a_call_cancelled_before_execution_cannot_write_storage() {
        let dir = storage_tmp();
        let mut r = req(
            "ms.storage.write('state.txt', 'started'); return { go = function() return {} end }",
            "go",
            serde_json::json!({}),
            &["pluginStorage.write"],
        );
        r.data_root = Some(dir.clone());
        r.cancel.cancel();
        let error = run(r).unwrap_err();
        assert!(error.to_string().contains("cancelled"), "{error}");
        assert!(!dir.join("state.txt").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_cancelled_call_stops_a_running_loop() {
        let mut r = req(
            "return { go = function() while true do end end }",
            "go",
            serde_json::json!({}),
            &[],
        );
        r.limits.timeout = Duration::from_secs(5);
        let canceller = r.cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            canceller.cancel();
        });
        let started = Instant::now();
        let err = run(r).expect_err("a cancelled loop must stop");
        assert!(err.to_string().contains("cancelled"), "{err}");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "stopped promptly"
        );
    }

    #[test]
    fn ms_date_reports_bad_input_and_units() {
        for source in [
            r#"return { go = function() return ms.date.format({}) end }"#,
            r#"return { go = function() return ms.date.add("2026-01-01T00:00:00Z", 1, "fortnight") end }"#,
            r#"return { go = function() return ms.date.add(true, 1, "day") end }"#,
        ] {
            assert!(
                run(req(source, "go", serde_json::json!({}), &[])).is_err(),
                "{source}"
            );
        }
        let out = run(req(
            r#"return { go = function() return { d = ms.date.format(0, "YYYY"), n = ms.date.now("YYYY", 1, "de") } end }"#,
            "go",
            serde_json::json!({}),
            &[],
        ))
        .unwrap();
        assert!(out["d"] == "1970" || out["d"] == "1969", "{out}");
        assert_eq!(out["n"].as_str().unwrap().len(), 4);
    }

    #[test]
    fn ms_native_tools_rejects_a_malformed_args_value() {
        let mut r = req(
            "return { go = function() return ms.nativeTools.run('t', { args = 'oops' }) end }",
            "go",
            serde_json::json!({}),
            &["nativeTools.runDeclared"],
        );
        r.native_tools
            .insert("t".into(), Some(PathBuf::from("/bin/true")));
        let err = run(r).unwrap_err();
        assert!(err.to_string().contains("args must be an array"), "{err}");
    }
}
