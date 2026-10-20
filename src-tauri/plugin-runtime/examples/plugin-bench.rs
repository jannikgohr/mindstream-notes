//! Portable runtime probe. Run in release mode; stdout is one JSON report.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use mindstream_plugin_runtime::{
    cancel::CancelToken,
    error::HostError,
    host::{CallSetup, NoteMeta},
    limits,
    wasm::{cache, Execution, Timings, WasmCall, WasmRuntime},
};
use serde_json::{json, Value};

const RUST: &[u8] = include_bytes!("../../../plugin-sdk/conformance/dist/conformance-rust.wasm");
const TYPESCRIPT: &[u8] =
    include_bytes!("../../../plugin-sdk/conformance/dist/conformance-ts.wasm");
const TEMPLATES: &[u8] = include_bytes!("../../../plugins/templates/plugin.wasm");
const TYPST: &[u8] = include_bytes!("../../../plugins/typst/plugin.wasm");

static MEASUREMENT_TIMEOUT_MS: OnceLock<u64> = OnceLock::new();

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn invoke(
    runtime: &WasmRuntime,
    component: &[u8],
    export: &str,
    input: &Value,
    setup: CallSetup,
    cache: &Path,
) -> Result<(Value, Timings), HostError> {
    runtime.invoke_timed(WasmCall {
        component,
        export,
        input,
        setup,
        // Use the app default unless the probe explicitly requests another limit.
        limits: limits::WASM.resolve(None, MEASUREMENT_TIMEOUT_MS.get().copied()),
        native_allowance: limits::NATIVE_ALLOWANCE,
        cache_dir: Some(cache),
    })
}

fn distribution(values: impl Iterator<Item = f64>) -> Value {
    let mut values: Vec<_> = values.collect();
    values.sort_by(f64::total_cmp);
    let percentile = |p: f64| values[((values.len() as f64 * p).ceil() as usize).saturating_sub(1)];
    json!({"p50": percentile(0.5), "p95": percentile(0.95), "max": values.last()})
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn sample(
    runtime: &WasmRuntime,
    component: &[u8],
    export: &str,
    input: Value,
    setup: CallSetup,
    cache: &Path,
    iterations: usize,
) -> Result<Value, Box<dyn std::error::Error>> {
    eprintln!(
        "measuring {export} for a {}-byte component",
        component.len()
    );
    let case_cache = cache.join(uuid::Uuid::new_v4().to_string());
    let cache = case_cache.as_path();
    runtime.clear_memory_cache();
    let (expected, cold) = invoke(runtime, component, export, &input, setup.clone(), cache)?;
    assert_eq!(cold.source, cache::Source::Compiled);
    let mut samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let (value, timing) = invoke(runtime, component, export, &input, setup.clone(), cache)?;
        assert_eq!(value, expected, "output changes across fresh instances");
        assert_eq!(timing.source, cache::Source::Memory);
        samples.push(timing);
    }
    runtime.clear_memory_cache();
    let (_, disk) = invoke(runtime, component, export, &input, setup, cache)?;
    assert_eq!(disk.source, cache::Source::Disk);
    Ok(json!({
        "componentSha256": cache::hex(&cache::digest(component)),
        "componentBytes": component.len(),
        "measurementTimeoutMs": MEASUREMENT_TIMEOUT_MS.get(),
        "coldSource": format!("{:?}", cold.source),
        "coldPrepareMs": ms(cold.prepare),
        "coldInstantiateMs": ms(cold.instantiate),
        "coldCallMs": ms(cold.call),
        "diskPrepareMs": ms(disk.prepare),
        "cachedPrepareMs": distribution(samples.iter().map(|s| ms(s.prepare))),
        "instantiateMs": distribution(samples.iter().map(|s| ms(s.instantiate))),
        "callMs": distribution(samples.iter().map(|s| ms(s.call))),
        "cachedTotalMs": distribution(samples.iter().map(|s| ms(s.prepare + s.instantiate + s.call))),
        "guestLinearMemoryBytes": samples.iter().map(|s| s.memory_bytes).max(),
        "output": expected,
    }))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let execution = if args.iter().any(|arg| arg == "--interpreter") {
        Execution::Interpreter
    } else {
        Execution::Native
    };
    let template_bytes = args
        .iter()
        .position(|arg| arg == "--templates-component")
        .map(|i| {
            std::fs::read(
                args.get(i + 1)
                    .ok_or("--templates-component needs a path")?,
            )
            .map_err(|e| e.to_string())
        })
        .transpose()?
        .unwrap_or_else(|| TEMPLATES.to_vec());
    let templates = template_bytes.as_slice();
    let iterations = args
        .iter()
        .position(|arg| arg == "--iterations")
        .map(|i| {
            args.get(i + 1)
                .ok_or("--iterations needs a value")?
                .parse::<usize>()
                .map_err(|_| "invalid iteration count")
        })
        .transpose()?
        .unwrap_or(100);
    if !(1..=10_000).contains(&iterations) {
        return Err("iterations must be in 1..=10000".into());
    }
    let timeout_ms = args
        .iter()
        .position(|arg| arg == "--timeout-ms")
        .map(|i| {
            args.get(i + 1)
                .ok_or("--timeout-ms needs a value")?
                .parse::<u64>()
                .map_err(|_| "invalid timeout")
        })
        .transpose()?
        .unwrap_or(1000);
    if !(50..=5000).contains(&timeout_ms) {
        return Err("timeout must be in 50..=5000 ms".into());
    }
    MEASUREMENT_TIMEOUT_MS.set(timeout_ms).unwrap();
    let scratch = Scratch(
        std::env::temp_dir().join(format!("mindstream-plugin-probe-{}", uuid::Uuid::new_v4())),
    );
    std::fs::create_dir_all(&scratch.0)?;
    let cache = scratch.0.join("cache");
    let runtime = WasmRuntime::new(execution)?;
    let setup = CallSetup {
        plugin_id: "com.example.probe".into(),
        ..CallSetup::default()
    };
    let mut cases = serde_json::Map::new();
    for (name, component) in [("rustEcho", RUST), ("typescriptEcho", TYPESCRIPT)] {
        cases.insert(
            name.into(),
            sample(
                &runtime,
                component,
                "echo",
                json!({"hello": "portable"}),
                setup.clone(),
                &cache,
                iterations,
            )?,
        );
    }
    cases.insert("templatesRender".into(), sample(&runtime, templates, "renderTemplate", json!({
        "now": "2026-07-25T10:00:00Z", "locale": "de", "title": "Log {{date:YYYY}}", "body": "{{title|upper}} {{date+7d:MMMM}}"
    }), setup.clone(), &cache, iterations)?);
    let notes = (0..500)
        .map(|i| NoteMeta {
            id: format!("n{i}"),
            title: format!("Template {i:03}"),
            tags: vec!["template".into()],
            kind: "markdown".into(),
            folder_id: None,
            folder_path: String::new(),
            created: String::new(),
            modified: String::new(),
        })
        .collect();
    cases.insert(
        "templatesMenu500".into(),
        sample(
            &runtime,
            templates,
            "newFromTemplate",
            json!({"settings": {"source-tag": "template"}}),
            CallSetup {
                permissions: vec!["notes.read".into(), "notes.create".into()],
                notes,
                ..setup.clone()
            },
            &cache,
            iterations,
        )?,
    );
    cases.insert(
        "typstPortable".into(),
        sample(
            &runtime,
            TYPST,
            "renderDocument",
            json!({"body": "= Hello"}),
            CallSetup {
                permissions: vec!["nativeTools.runDeclared".into()],
                native_tools: HashMap::from([("typst".into(), None)]),
                ..setup.clone()
            },
            &cache,
            iterations,
        )?,
    );

    let mut reports = Vec::new();
    for (name, component) in [("rust", RUST), ("typescript", TYPESCRIPT)] {
        let data = scratch.0.join(name);
        std::fs::create_dir_all(&data)?;
        let host = CallSetup {
            permissions: vec![
                "notes.read".into(),
                "pluginStorage.read".into(),
                "pluginStorage.write".into(),
                "nativeTools.runDeclared".into(),
            ],
            data_root: Some(data),
            ..setup.clone()
        };
        reports.push(invoke(&runtime, component, "report", &json!({}), host, &cache)?.0);
        let denied = invoke(
            &runtime,
            component,
            "report",
            &json!({}),
            setup.clone(),
            &cache,
        )?
        .0;
        assert_eq!(denied["storage"]["write"]["err"]["kind"], "denied");
        assert_eq!(denied["notes"]["all"]["err"]["kind"], "denied");
    }
    assert_eq!(
        reports[0], reports[1],
        "Rust and TypeScript host contracts differ"
    );

    let mut controls = Vec::new();
    for (name, component) in [("rust", RUST), ("typescript", TYPESCRIPT)] {
        invoke(
            &runtime,
            component,
            "echo",
            &json!({}),
            setup.clone(),
            &cache,
        )?;
        let token = CancelToken::new();
        let cancel = token.clone();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            cancel.cancel();
        });
        let started = Instant::now();
        let stopped = runtime.invoke(WasmCall {
            component,
            export: "spin",
            input: &json!({}),
            setup: CallSetup {
                cancel: token,
                ..setup.clone()
            },
            limits: limits::WASM.resolve(None, Some(5000)),
            native_allowance: Duration::ZERO,
            cache_dir: Some(&cache),
        });
        worker.join().expect("canceller exits");
        assert!(
            matches!(stopped, Err(HostError::Cancelled)),
            "{name}: {stopped:?}"
        );
        let cancel_ms = ms(started.elapsed());
        assert!(cancel_ms < 2000.0, "{name} cancellation stalled");
        let started = Instant::now();
        let timed_out = runtime.invoke(WasmCall {
            component,
            export: "spin",
            input: &json!({}),
            setup: setup.clone(),
            limits: limits::WASM.resolve(None, Some(100)),
            native_allowance: Duration::ZERO,
            cache_dir: Some(&cache),
        });
        assert!(
            matches!(timed_out, Err(HostError::Budget)),
            "{name}: {timed_out:?}"
        );
        let timeout_ms = ms(started.elapsed());
        assert!(timeout_ms < 2000.0, "{name} timeout stalled");
        let exhausted = runtime.invoke(WasmCall {
            component,
            export: "grow",
            input: &json!({}),
            setup: setup.clone(),
            limits: limits::WASM.resolve(Some(4 * 1024 * 1024), Some(2000)),
            native_allowance: Duration::ZERO,
            cache_dir: Some(&cache),
        });
        assert!(
            !matches!(exhausted, Err(HostError::Budget | HostError::Cancelled)),
            "{name} did not reach its memory limit before interruption"
        );
        assert!(
            exhausted.is_err(),
            "{name} exceeded the guest memory budget"
        );
        controls.push(json!({"language": name, "cancelMs": cancel_ms, "timeoutMs": timeout_ms, "memoryRefusal": exhausted.unwrap_err().to_string()}));
    }
    assert_eq!(runtime.running(), 0);
    // Linux and Android expose these; other platforms collect process memory
    // separately. Guest linear memory above is portable and is a different metric.
    let process_memory = std::fs::read_to_string("/proc/self/status")
        .ok()
        .map(|status| {
            status
                .lines()
                .filter(|line| line.starts_with("VmRSS:") || line.starts_with("VmHWM:"))
                .map(String::from)
                .collect::<Vec<_>>()
        });
    let pss = std::fs::read_to_string("/proc/self/smaps_rollup")
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find(|line| line.starts_with("Pss:"))
                .map(String::from)
        });
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "schemaVersion": 1, "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
            "execution": format!("{execution:?}"), "releaseBuild": !cfg!(debug_assertions), "iterations": iterations,
            "cases": cases, "hostReport": reports[0], "controls": controls,
            "processMemory": process_memory, "processPss": pss,
        }))?
    );
    Ok(())
}
