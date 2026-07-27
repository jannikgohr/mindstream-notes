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
//!      stdlib is already curated: no `io`, no `os.execute`, no `package`, no
//!      `ffi` — the dangerous surface simply isn't there. The one `require` a
//!      script sees is our plugin-scoped shim, which resolves only the plugin's
//!      own bundled `.luau` modules — never the filesystem (see
//!      [`install_require`]).
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

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::rc::Rc;
use std::time::{Duration, Instant};

use mlua::{Lua, LuaSerdeExt, MultiValue, Table, Value, VmState};
use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Read-only metadata for one note, exposed to scripts through `ms.notes`
/// (gated by `notes.read`). Body is deliberately omitted — the snapshot is cheap
/// to build and copy; a body/include seam can come later. Field names are the
/// keys a script sees on the Lua table.
#[derive(Debug, Clone, Serialize)]
pub struct NoteMeta {
    pub id: String,
    pub title: String,
    pub tags: Vec<String>,
    /// Editor kind (`"markdown"`, `"kanban"`, …) so a script can filter.
    pub kind: String,
    pub folder_id: Option<String>,
    /// Human path of the containing folder, e.g. `"Work / Projects"`.
    pub folder_path: String,
    pub created: String,
    pub modified: String,
}

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
    /// Read-only note snapshot exposed via `ms.notes` when `notes.read` is
    /// granted. Built by the caller before the script runs; empty otherwise.
    pub notes: Vec<NoteMeta>,
    /// The plugin's other `.luau` files as `module path (no extension) → source`,
    /// so the script can split itself across files via a plugin-scoped `require`.
    /// Keys use `/` separators; only these modules are resolvable (no filesystem
    /// or host access), so `require` can't reach outside the plugin bundle.
    pub modules: HashMap<String, String>,
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

    install_host_api(&lua, &req.permissions, &req.notes)
        .map_err(|e| map_lua(&req.chunk_name, e))?;
    install_require(&lua, req.modules).map_err(|e| map_lua(&req.chunk_name, e))?;

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

/// Install the `ms.*` host API.
///
/// The design goal is *general* primitives usable by any plugin, not
/// template-specific ones: dates, JSON, markdown helpers, and (gated) read
/// access to the vault. Safe, side-effect-free helpers are always present;
/// capability namespaces are gated on the plugin's granted permissions, so a
/// script can only reach what its manifest asked for.
fn install_host_api(lua: &Lua, permissions: &[String], notes: &[NoteMeta]) -> mlua::Result<()> {
    let ms = lua.create_table()?;
    let granted = |p: &str| permissions.iter().any(|g| g == p);

    // --- Always available (pure / side-effect-free) -----------------------
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

    ms.set("date", date_module(lua)?)?;
    ms.set("json", json_module(lua)?)?;
    ms.set("md", md_module(lua)?)?;

    // --- Gated: notes.read → ms.notes (read-only metadata snapshot) --------
    if granted("notes.read") {
        ms.set("notes", notes_module(lua, notes)?)?;
    }

    lua.globals().set("ms", ms)?;
    Ok(())
}

/// Install a **plugin-scoped `require`** so a script can split itself across
/// several `.luau` files.
///
/// `modules` is the plugin's own `.luau` files (keyed by module path without the
/// extension); `require(name)` resolves *only* these — never the filesystem,
/// network, or another plugin — so it can't reach outside the already-signed
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

/// `ms.date`: current time + formatting + arithmetic, all in local time and
/// using the same moment-style tokens as the frontend template engine
/// (`YYYY-MM-DD`, `HH:mm`, `dddd`, …), so a script's dates match `{{date:…}}`.
fn date_module(lua: &Lua) -> mlua::Result<Table> {
    let date = lua.create_table()?;
    // now(format?, offsetDays?) → the current local date/time, formatted.
    date.set(
        "now",
        lua.create_function(|_, (fmt, offset): (Option<String>, Option<i64>)| {
            let dt = chrono::Local::now() + chrono::Duration::days(offset.unwrap_or(0));
            Ok(format_moment(&dt, fmt.as_deref().unwrap_or("YYYY-MM-DD")))
        })?,
    )?;
    // format(input, format?) → format an RFC3339 string or epoch seconds.
    date.set(
        "format",
        lua.create_function(|_, (input, fmt): (Value, Option<String>)| {
            let dt = parse_datetime(&input).ok_or_else(|| {
                mlua::Error::runtime(
                    "ms.date.format: input must be an RFC3339 string or epoch seconds",
                )
            })?;
            Ok(format_moment(&dt, fmt.as_deref().unwrap_or("YYYY-MM-DD")))
        })?,
    )?;
    // add(input, amount, unit) → shift a date, returning RFC3339. Units:
    // second|minute|hour|day|week|month|year (singular or plural).
    date.set(
        "add",
        lua.create_function(|_, (input, amount, unit): (Value, i64, String)| {
            let dt = parse_datetime(&input).ok_or_else(|| {
                mlua::Error::runtime(
                    "ms.date.add: input must be an RFC3339 string or epoch seconds",
                )
            })?;
            let shifted = add_duration(dt, amount, &unit).ok_or_else(|| {
                mlua::Error::runtime(format!("ms.date.add: unknown unit '{unit}'"))
            })?;
            Ok(shifted.to_rfc3339())
        })?,
    )?;
    Ok(date)
}

/// `ms.json`: encode a Lua value to a JSON string and back — a general
/// serialization primitive (config, structured data, interop).
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

/// `ms.md`: markdown helpers. General enough for any plugin producing markdown.
fn md_module(lua: &Lua) -> mlua::Result<Table> {
    let md = lua.create_table()?;
    // frontmatter(table) → a `---`-delimited YAML block from a table.
    md.set(
        "frontmatter",
        lua.create_function(|lua, tbl: Table| {
            let json: serde_json::Value = lua.from_value(Value::Table(tbl))?;
            frontmatter(&json).map_err(mlua::Error::runtime)
        })?,
    )?;
    Ok(md)
}

/// `ms.notes`: read-only access to the vault's note metadata (gated by
/// `notes.read`). Built from a snapshot the caller captured before running, so
/// it's cheap and can't stall the script.
fn notes_module(lua: &Lua, notes: &[NoteMeta]) -> mlua::Result<Table> {
    let ms_notes = lua.create_table()?;
    let all: std::sync::Arc<Vec<NoteMeta>> = std::sync::Arc::new(notes.to_vec());

    let all_get = all.clone();
    ms_notes.set(
        "all",
        lua.create_function(move |lua, ()| lua.to_value(&*all_get))?,
    )?;
    let all_find = all.clone();
    ms_notes.set(
        "get",
        lua.create_function(
            move |lua, id: String| match all_find.iter().find(|n| n.id == id) {
                Some(note) => lua.to_value(note),
                None => Ok(Value::Nil),
            },
        )?,
    )?;
    Ok(ms_notes)
}

// English month/weekday names (moment's default locale), kept locale-independent
// on the backend; the frontend engine localizes via Intl where it matters.
const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const MONTHS_SHORT: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const WEEKDAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];
const WEEKDAYS_SHORT: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// Format a local datetime with moment-style tokens (`YYYY MM DD HH mm ss`,
/// named `MMMM/MMM/dddd/ddd`, `hh h A a`, `[escaped]` literals). Unknown
/// characters pass through. Mirrors the frontend `formatDate` token set.
fn format_moment(dt: &chrono::DateTime<chrono::Local>, fmt: &str) -> String {
    use chrono::{Datelike, Timelike};
    let chars: Vec<char> = fmt.chars().collect();
    let month0 = dt.month0() as usize;
    let weekday0 = dt.weekday().num_days_from_sunday() as usize;
    let h24 = dt.hour();
    let h12 = match h24 % 12 {
        0 => 12,
        h => h,
    };
    // Tokens tried longest-first at each position.
    const TOKENS: [&str; 21] = [
        "YYYY", "YY", "MMMM", "MMM", "MM", "M", "DD", "D", "dddd", "ddd", "HH", "H", "hh", "h",
        "mm", "m", "ss", "s", "A", "a", "[",
    ];
    let mut out = String::new();
    let mut i = 0;
    'outer: while i < chars.len() {
        // `[literal]` — copy verbatim up to the next `]`.
        if chars[i] == '[' {
            let mut j = i + 1;
            while j < chars.len() && chars[j] != ']' {
                out.push(chars[j]);
                j += 1;
            }
            i = if j < chars.len() { j + 1 } else { j };
            continue;
        }
        for tok in TOKENS {
            if tok == "[" {
                continue;
            }
            let t: Vec<char> = tok.chars().collect();
            if chars[i..].starts_with(&t[..]) {
                match tok {
                    "YYYY" => {
                        let _ = write!(out, "{}", dt.year());
                    }
                    "YY" => {
                        let _ = write!(out, "{:02}", dt.year().rem_euclid(100));
                    }
                    "MMMM" => out.push_str(MONTHS[month0]),
                    "MMM" => out.push_str(MONTHS_SHORT[month0]),
                    "MM" => {
                        let _ = write!(out, "{:02}", month0 + 1);
                    }
                    "M" => {
                        let _ = write!(out, "{}", month0 + 1);
                    }
                    "DD" => {
                        let _ = write!(out, "{:02}", dt.day());
                    }
                    "D" => {
                        let _ = write!(out, "{}", dt.day());
                    }
                    "dddd" => out.push_str(WEEKDAYS[weekday0]),
                    "ddd" => out.push_str(WEEKDAYS_SHORT[weekday0]),
                    "HH" => {
                        let _ = write!(out, "{:02}", h24);
                    }
                    "H" => {
                        let _ = write!(out, "{}", h24);
                    }
                    "hh" => {
                        let _ = write!(out, "{:02}", h12);
                    }
                    "h" => {
                        let _ = write!(out, "{}", h12);
                    }
                    "mm" => {
                        let _ = write!(out, "{:02}", dt.minute());
                    }
                    "m" => {
                        let _ = write!(out, "{}", dt.minute());
                    }
                    "ss" => {
                        let _ = write!(out, "{:02}", dt.second());
                    }
                    "s" => {
                        let _ = write!(out, "{}", dt.second());
                    }
                    "A" => out.push_str(if h24 < 12 { "AM" } else { "PM" }),
                    "a" => out.push_str(if h24 < 12 { "am" } else { "pm" }),
                    _ => {}
                }
                i += t.len();
                continue 'outer;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Parse a Lua value (RFC3339 string or epoch seconds) into a local datetime.
fn parse_datetime(value: &Value) -> Option<chrono::DateTime<chrono::Local>> {
    match value {
        Value::String(s) => chrono::DateTime::parse_from_rfc3339(&s.to_str().ok()?)
            .ok()
            .map(|dt| dt.with_timezone(&chrono::Local)),
        Value::Integer(secs) => chrono::DateTime::from_timestamp(*secs as i64, 0)
            .map(|dt| dt.with_timezone(&chrono::Local)),
        Value::Number(secs) => chrono::DateTime::from_timestamp(*secs as i64, 0)
            .map(|dt| dt.with_timezone(&chrono::Local)),
        _ => None,
    }
}

/// Shift a datetime by `amount` of `unit`. Returns `None` for an unknown unit.
fn add_duration(
    dt: chrono::DateTime<chrono::Local>,
    amount: i64,
    unit: &str,
) -> Option<chrono::DateTime<chrono::Local>> {
    use chrono::Duration;
    let by = |d: Duration| Some(dt + d);
    match unit.trim_end_matches('s') {
        "second" => by(Duration::seconds(amount)),
        "minute" => by(Duration::minutes(amount)),
        "hour" => by(Duration::hours(amount)),
        "day" => by(Duration::days(amount)),
        "week" => by(Duration::weeks(amount)),
        "month" => Some(add_months(dt, amount)),
        "year" => Some(add_months(dt, amount * 12)),
        _ => None,
    }
}

/// Add (or subtract) whole months, clamping the day to the target month's length.
fn add_months(dt: chrono::DateTime<chrono::Local>, months: i64) -> chrono::DateTime<chrono::Local> {
    use chrono::{Datelike, TimeZone, Timelike};
    let total = dt.year() as i64 * 12 + dt.month0() as i64 + months;
    let year = total.div_euclid(12) as i32;
    let month0 = total.rem_euclid(12) as u32;
    let last_day = days_in_month(year, month0 + 1);
    let day = dt.day().min(last_day);
    chrono::Local
        .with_ymd_and_hms(year, month0 + 1, day, dt.hour(), dt.minute(), dt.second())
        .single()
        .unwrap_or(dt)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

/// Serialize a JSON object to a `---`-delimited YAML frontmatter block. Supports
/// scalar values and arrays of scalars (one level) — enough for note metadata.
fn frontmatter(value: &serde_json::Value) -> Result<String, String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "ms.md.frontmatter expects a table".to_string())?;
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
            notes: Vec::new(),
            modules: HashMap::new(),
            limits: Limits::default(),
        }
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
    fn format_moment_covers_the_token_set() {
        use chrono::TimeZone;
        let dt = chrono::Local
            .with_ymd_and_hms(2026, 7, 25, 14, 5, 9)
            .single()
            .unwrap();
        assert_eq!(
            format_moment(&dt, "YYYY-MM-DD HH:mm:ss"),
            "2026-07-25 14:05:09"
        );
        assert_eq!(format_moment(&dt, "dddd, MMMM D"), "Saturday, July 25");
        assert_eq!(format_moment(&dt, "hh:mm A"), "02:05 PM");
        assert_eq!(format_moment(&dt, "[Week] YYYY"), "Week 2026");
    }
}
