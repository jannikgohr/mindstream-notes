//! Sandboxed Wasmi execution for scripted (`runtime: "wasm"`) plugins.
//!
//! This tier mirrors the Luau security posture while targeting heavier compute:
//! parsed modules are cached by the signed package checksum, every call gets a
//! fresh [`Store`] and instance, no WASI is linked, and host imports are
//! installed only for granted permissions. The ABI is deliberately small:
//!
//!   - export `memory`
//!   - export `alloc(len: i32) -> i32`
//!   - optionally export `dealloc(ptr: i32, len: i32)`
//!   - export the requested function as `(input_ptr: i32, input_len: i32) -> i64`
//!
//! The returned `i64` packs `(result_ptr << 32) | result_len`, and both input
//! and output bytes are UTF-8 JSON. As with Luau, plugins return declarative
//! effects/data; the app performs all writes.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use wasmi::{
    Caller, Config, Engine, Linker, Memory, Module, Store, StoreLimits, StoreLimitsBuilder,
    TypedFunc,
};

use super::luau::NoteMeta;
use crate::error::{AppError, AppResult};

/// Resource bounds for one wasm invocation.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Maximum bytes for each guest linear memory.
    pub memory_bytes: usize,
    /// Wall-clock deadline checked at Wasm/host call boundaries.
    pub timeout: Duration,
    /// Deterministic instruction budget enforced through Wasmi fuel.
    pub fuel: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            // Typst-class guests need room for fonts and layout data. Still
            // bounded and per-memory, with no WASI/host filesystem.
            memory_bytes: 128 * 1024 * 1024,
            timeout: Duration::from_secs(5),
            fuel: 100_000_000,
        }
    }
}

/// One wasm plugin invocation request.
pub struct ScriptRequest {
    pub wasm: Vec<u8>,
    /// Human name for diagnostics, e.g. `<id>/main.wasm`.
    pub module_name: String,
    /// Package checksum from discovery/signing; used as the parsed-module
    /// cache key so any signed package edit causes a fresh parse.
    pub checksum: String,
    pub export: String,
    pub input: serde_json::Value,
    pub permissions: Vec<String>,
    pub notes: Vec<NoteMeta>,
    pub limits: Limits,
}

struct HostState {
    notes: Vec<NoteMeta>,
    limits: StoreLimits,
}

fn err(msg: impl Into<String>) -> AppError {
    AppError::InvalidArg(msg.into())
}

fn map_wasm(module: &str, e: impl std::fmt::Display) -> AppError {
    err(format!("wasm ({module}): {e}"))
}

fn engine() -> &'static Engine {
    static ENGINE: OnceLock<Engine> = OnceLock::new();
    ENGINE.get_or_init(|| {
        let mut config = Config::default();
        config.consume_fuel(true);
        config.ignore_custom_sections(true);
        Engine::new(&config)
    })
}

fn module_cache() -> &'static Mutex<HashMap<String, Module>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Module>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_module(req: &ScriptRequest) -> AppResult<Module> {
    let key = format!("{}:{}", req.checksum, req.module_name);
    if let Some(module) = module_cache().lock().expect("module cache").get(&key) {
        return Ok(module.clone());
    }
    let module = Module::new(engine(), &req.wasm).map_err(|e| map_wasm(&req.module_name, e))?;
    module_cache()
        .lock()
        .expect("module cache")
        .insert(key, module.clone());
    Ok(module)
}

fn install_host_api(
    linker: &mut Linker<HostState>,
    module_name: &str,
    permissions: &[String],
) -> AppResult<()> {
    let granted = |p: &str| permissions.iter().any(|g| g == p);
    if granted("notes.read") {
        linker
            .func_wrap(
                "ms",
                "notes_count",
                |caller: Caller<'_, HostState>| -> i32 {
                    caller.data().notes.len().min(i32::MAX as usize) as i32
                },
            )
            .map_err(|e| map_wasm(module_name, e))?;
    }
    Ok(())
}

fn read_guest_bytes(
    module_name: &str,
    memory: &Memory,
    store: &Store<HostState>,
    ptr: u32,
    len: u32,
) -> AppResult<Vec<u8>> {
    let start = ptr as usize;
    let len = len as usize;
    start
        .checked_add(len)
        .ok_or_else(|| err(format!("wasm ({module_name}): result pointer overflow")))?;
    let mut output = vec![0; len];
    memory
        .read(store, start, &mut output)
        .map_err(|e| map_wasm(module_name, e))?;
    Ok(output)
}

fn write_guest_bytes(
    module_name: &str,
    memory: &Memory,
    store: &mut Store<HostState>,
    ptr: i32,
    bytes: &[u8],
) -> AppResult<()> {
    if ptr < 0 {
        return Err(err(format!(
            "wasm ({module_name}): alloc returned a negative pointer"
        )));
    }
    memory
        .write(&mut *store, ptr as usize, bytes)
        .map_err(|e| map_wasm(module_name, e))
}

fn unpack_ptr_len(packed: i64) -> (u32, u32) {
    (
        (packed as u64 >> 32) as u32,
        (packed as u64 & 0xffff_ffff) as u32,
    )
}

fn call_dealloc(
    store: &mut Store<HostState>,
    dealloc: Option<TypedFunc<(i32, i32), ()>>,
    ptr: i32,
    len: i32,
) {
    if let Some(dealloc) = dealloc {
        let _ = dealloc.call(&mut *store, (ptr, len));
    }
}

/// Run one wasm export and return its JSON result.
pub fn run(req: ScriptRequest) -> AppResult<serde_json::Value> {
    let module = cached_module(&req)?;
    let mut linker = Linker::new(engine());
    install_host_api(&mut linker, &req.module_name, &req.permissions)?;

    let limits = StoreLimitsBuilder::new()
        .memory_size(req.limits.memory_bytes)
        .memories(1)
        .tables(2)
        .instances(1)
        .table_elements(10_000)
        .trap_on_grow_failure(true)
        .build();
    let mut store = Store::new(
        engine(),
        HostState {
            notes: req.notes,
            limits,
        },
    );
    store.limiter(|state| &mut state.limits);
    store
        .set_fuel(req.limits.fuel)
        .map_err(|e| map_wasm(&req.module_name, e))?;

    let started_at = Instant::now();
    let timeout = req.limits.timeout;
    store.call_hook(move |_, _| {
        if started_at.elapsed() > timeout {
            Err(wasmi::Error::new("wall-clock timeout"))
        } else {
            Ok(())
        }
    });

    let instance = linker
        .instantiate_and_start(&mut store, &module)
        .map_err(|e| map_wasm(&req.module_name, e))?;
    let memory = instance
        .get_memory(&store, "memory")
        .ok_or_else(|| err(format!("wasm ({}): missing memory export", req.module_name)))?;
    let alloc = instance
        .get_typed_func::<i32, i32>(&store, "alloc")
        .map_err(|e| map_wasm(&req.module_name, e))?;
    let dealloc = instance
        .get_typed_func::<(i32, i32), ()>(&store, "dealloc")
        .ok();
    let func = instance
        .get_typed_func::<(i32, i32), i64>(&store, &req.export)
        .map_err(|e| map_wasm(&req.module_name, e))?;

    let input = serde_json::to_vec(&req.input).map_err(|e| map_wasm(&req.module_name, e))?;
    let input_len: i32 = input
        .len()
        .try_into()
        .map_err(|_| err(format!("wasm ({}): input is too large", req.module_name)))?;
    let input_ptr = alloc
        .call(&mut store, input_len)
        .map_err(|e| map_wasm(&req.module_name, e))?;
    write_guest_bytes(&req.module_name, &memory, &mut store, input_ptr, &input)?;

    let packed = func
        .call(&mut store, (input_ptr, input_len))
        .map_err(|e| map_wasm(&req.module_name, e))?;
    call_dealloc(&mut store, dealloc, input_ptr, input_len);

    let (out_ptr, out_len) = unpack_ptr_len(packed);
    let output = read_guest_bytes(&req.module_name, &memory, &store, out_ptr, out_len)?;
    call_dealloc(&mut store, dealloc, out_ptr as i32, out_len as i32);
    serde_json::from_slice(&output).map_err(|e| {
        err(format!(
            "wasm ({}): export '{}' returned invalid JSON: {e}",
            req.module_name, req.export
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack(ptr: u32, len: usize) -> u64 {
        ((ptr as u64) << 32) | len as u64
    }

    fn wat_string(s: &str) -> String {
        s.replace('\\', "\\5c")
            .replace('"', "\\22")
            .replace('\n', "\\0a")
    }

    fn data_module(json: &str) -> Vec<u8> {
        let packed = pack(32, json.len());
        let json = wat_string(json);
        wat::parse_str(format!(
            r#"(module
              (memory (export "memory") 1)
              (global $heap (mut i32) (i32.const 1024))
              (func (export "alloc") (param $len i32) (result i32)
                (local $ptr i32)
                global.get $heap
                local.set $ptr
                global.get $heap
                local.get $len
                i32.add
                global.set $heap
                local.get $ptr)
              (func (export "dealloc") (param i32) (param i32))
              (data (i32.const 32) "{json}")
              (func (export "render") (param i32) (param i32) (result i64)
                i64.const {packed}))
            "#
        ))
        .unwrap()
    }

    fn req(wasm: Vec<u8>, perms: &[&str]) -> ScriptRequest {
        ScriptRequest {
            wasm,
            module_name: "test/main.wasm".into(),
            checksum: uuid::Uuid::new_v4().to_string(),
            export: "render".into(),
            input: serde_json::json!({ "name": "world" }),
            permissions: perms.iter().map(|p| p.to_string()).collect(),
            notes: Vec::new(),
            limits: Limits::default(),
        }
    }

    #[test]
    fn calls_exported_function_and_decodes_json_effect() {
        let out = run(req(
            data_module(r#"{"effect":"toast","message":"hello from wasm"}"#),
            &[],
        ))
        .unwrap();
        assert_eq!(out["effect"], serde_json::json!("toast"));
        assert_eq!(out["message"], serde_json::json!("hello from wasm"));
    }

    #[test]
    fn fuel_exhaustion_traps_runaway_guest() {
        let wasm = wat::parse_str(
            r#"(module
              (memory (export "memory") 1)
              (global $heap (mut i32) (i32.const 1024))
              (func (export "alloc") (param $len i32) (result i32)
                global.get $heap
                global.get $heap
                local.get $len
                i32.add
                global.set $heap)
              (func (export "render") (param i32) (param i32) (result i64)
                (loop $forever
                  br $forever)
                i64.const 0))
            "#,
        )
        .unwrap();
        let mut r = req(wasm, &[]);
        r.limits.fuel = 10_000;
        r.limits.timeout = Duration::from_secs(10);
        assert!(run(r).is_err(), "runaway guest must exhaust fuel");
    }

    #[test]
    fn memory_limit_traps_growth() {
        let json = r#"{"ok":true}"#;
        let wasm = wat::parse_str(format!(
            r#"(module
              (memory (export "memory") 1)
              (global $heap (mut i32) (i32.const 1024))
              (func (export "alloc") (param i32) (result i32) i32.const 1024)
              (data (i32.const 32) "{}")
              (func (export "render") (param i32) (param i32) (result i64)
                i32.const 2
                memory.grow
                drop
                i64.const {}))
            "#,
            wat_string(json),
            pack(32, json.len())
        ))
        .unwrap();
        let mut r = req(wasm, &[]);
        r.limits.memory_bytes = 64 * 1024;
        assert!(run(r).is_err(), "guest memory growth must be bounded");
    }

    #[test]
    fn notes_import_is_gated_on_notes_read() {
        let ok = r#"{"ok":true}"#;
        let no = r#"{"ok":false}"#;
        let ok_wat = wat_string(ok);
        let no_wat = wat_string(no);
        let wasm = wat::parse_str(format!(
            r#"(module
              (import "ms" "notes_count" (func $notes_count (result i32)))
              (memory (export "memory") 1)
              (global $heap (mut i32) (i32.const 1024))
              (func (export "alloc") (param i32) (result i32) i32.const 1024)
              (data (i32.const 32) "{ok_wat}")
              (data (i32.const 64) "{no_wat}")
              (func (export "render") (param i32) (param i32) (result i64)
                call $notes_count
                i32.const 2
                i32.eq
                if (result i64)
                  i64.const {}
                else
                  i64.const {}
                end))
            "#,
            pack(32, ok.len()),
            pack(64, no.len())
        ))
        .unwrap();

        assert!(run(req(wasm.clone(), &[])).is_err());

        let mut with_perm = req(wasm, &["notes.read"]);
        with_perm.notes = vec![
            NoteMeta {
                id: "a".into(),
                title: "A".into(),
                tags: Vec::new(),
                kind: "markdown".into(),
                folder_id: None,
                folder_path: String::new(),
                created: String::new(),
                modified: String::new(),
            },
            NoteMeta {
                id: "b".into(),
                title: "B".into(),
                tags: Vec::new(),
                kind: "markdown".into(),
                folder_id: None,
                folder_path: String::new(),
                created: String::new(),
                modified: String::new(),
            },
        ];
        let out = run(with_perm).unwrap();
        assert_eq!(out["ok"], serde_json::json!(true));
    }
}
