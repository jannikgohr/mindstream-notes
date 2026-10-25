//! Portable runtime probe. Run in release mode; stdout is one JSON report.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use mindstream_plugin_fixtures as fixtures;
use mindstream_plugin_runtime::{
    cancel::CancelToken,
    error::HostError,
    host::{CallSetup, NoteMeta},
    limits,
    wasm::{cache, precompiled::VerifiedComponent, Execution, Timings, WasmCall, WasmRuntime},
};
use serde_json::{json, Value};

const RUST: &[u8] = fixtures::CONFORMANCE_RUST;
const TYPESCRIPT: &[u8] = fixtures::CONFORMANCE_TS;
const TEMPLATES: &[u8] = include_bytes!("../../../plugins/templates/plugin.wasm");
const TYPST: &[u8] = include_bytes!("../../../plugins/typst/plugin.wasm");
const TEMPLATES_TS: &[u8] = fixtures::TEMPLATES_TYPESCRIPT;
const TYPST_TS: &[u8] = fixtures::TYPST_TYPESCRIPT;
const TEMPLATES_RUST: &[u8] = fixtures::TEMPLATES_RUST;
const TEMPLATES_LOCAL: &[u8] = fixtures::TEMPLATES_RUST_LOCAL_CALENDAR;
const TEMPLATES_BATCH: &[u8] = fixtures::TEMPLATES_RUST_BATCH;

type Artifact = ([u8; 32], [u8; 32], &'static str, &'static [u8]);
#[cfg(feature = "probe-precompiled")]
const PRECOMPILED: &[Artifact] = include!(env!("MINDSTREAM_PROBE_PRECOMPILED"));
#[cfg(not(feature = "probe-precompiled"))]
const PRECOMPILED: &[Artifact] = &[];
static USE_PRECOMPILED: OnceLock<bool> = OnceLock::new();
static REHASH: OnceLock<bool> = OnceLock::new();

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
    if values.is_empty() {
        return Value::Null;
    }
    values.sort_by(f64::total_cmp);
    let percentile = |p: f64| values[((values.len() as f64 * p).ceil() as usize).saturating_sub(1)];
    json!({"p50": percentile(0.5), "p95": percentile(0.95), "max": values.last()})
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn process_memory() -> Value {
    let status = std::fs::read_to_string("/proc/self/status").ok();
    let pss = std::fs::read_to_string("/proc/self/smaps_rollup").ok();
    json!({
        "status": status.map(|status| status.lines()
            .filter(|line| line.starts_with("VmRSS:") || line.starts_with("VmHWM:"))
            .map(String::from).collect::<Vec<_>>()),
        "pss": pss.and_then(|status| status.lines()
            .find(|line| line.starts_with("Pss:")).map(String::from)),
    })
}

/// Record a call the time budget stopped instead of ending the probe.
fn within_budget(
    overruns: &mut Vec<f64>,
    call: impl FnOnce() -> Result<(Value, Timings), HostError>,
) -> Result<Option<(Value, Timings)>, HostError> {
    let started = Instant::now();
    match call() {
        Ok(result) => Ok(Some(result)),
        Err(HostError::Budget) => {
            overruns.push(ms(started.elapsed()));
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn sample(
    runtime: &WasmRuntime,
    component: &VerifiedComponent,
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
    let verified = component;
    let artifact = if USE_PRECOMPILED.get() == Some(&true) {
        let key = cache::engine_key(runtime.engine());
        let entry = PRECOMPILED
            .iter()
            .find(|a| a.0 == verified.digest() && a.2 == key)
            .ok_or("no matching trusted precompiled artifact in this probe build")?;
        // SAFETY: this standalone probe embeds only app-build compiler output.
        Some(unsafe {
            mindstream_plugin_runtime::wasm::precompiled::TrustedPrecompiled::new(
                entry.0, entry.1, entry.2, entry.3,
            )
        })
    } else {
        None
    };
    let call = || {
        runtime.invoke_verified_timed(
            WasmCall {
                component: verified,
                export,
                input: &input,
                setup: setup.clone(),
                limits: limits::WASM.resolve(None, MEASUREMENT_TIMEOUT_MS.get().copied()),
                native_allowance: limits::NATIVE_ALLOWANCE,
                cache_dir: Some(cache),
            },
            if REHASH.get() == Some(&true) {
                None
            } else {
                Some(verified)
            },
            artifact.as_ref(),
        )
    };
    // Calls stopped by the time budget. They are reported, not retried, and
    // fail the run after the report is written.
    let mut overruns = Vec::new();
    runtime.clear_memory_cache();
    let before_compile = process_memory();
    let cold = within_budget(&mut overruns, call)?;
    if let Some((_, timing)) = &cold {
        assert_eq!(
            timing.source,
            if artifact.is_some() {
                cache::Source::Bundled
            } else {
                cache::Source::Compiled
            }
        );
    }
    let after_cold = process_memory();
    let mut expected = cold.as_ref().map(|(value, _)| value.clone());
    let mut samples = Vec::with_capacity(iterations);
    let mut memory_samples = Vec::new();
    for index in 0..iterations {
        if let Some((value, timing)) = within_budget(&mut overruns, call)? {
            let first = expected.get_or_insert_with(|| value.clone());
            assert_eq!(&value, first, "output changes across fresh instances");
            assert_eq!(timing.source, cache::Source::Memory);
            samples.push(timing);
        }
        if [1, 10, 50, iterations].contains(&(index + 1)) {
            memory_samples.push(json!({
                "attemptedWarmCalls": index + 1,
                "successfulWarmCalls": samples.len(),
                "memory": process_memory(),
            }));
        }
    }
    runtime.clear_memory_cache();
    let disk = within_budget(&mut overruns, call)?;
    if let Some((_, timing)) = &disk {
        assert_eq!(timing.source, cache::Source::Disk);
    }
    let cold = cold.map(|(_, timing)| timing);
    Ok(json!({
        "componentSha256": cache::hex(&cache::digest(component)),
        "componentBytes": component.len(),
        "verifiedDigestReused": REHASH.get() != Some(&true),
        "precompiledRequested": USE_PRECOMPILED.get() == Some(&true),
        "measurementTimeoutMs": MEASUREMENT_TIMEOUT_MS.get(),
        "coldSource": cold.map(|t| format!("{:?}", t.source)),
        "coldPrepareMs": cold.map(|t| ms(t.prepare)),
        "coldInstantiateMs": cold.map(|t| ms(t.instantiate)),
        "coldCallMs": cold.map(|t| ms(t.call)),
        "diskPrepareMs": disk.map(|(_, t)| ms(t.prepare)),
        "cachedPrepareMs": distribution(samples.iter().map(|s| ms(s.prepare))),
        "instantiateMs": distribution(samples.iter().map(|s| ms(s.instantiate))),
        "callMs": distribution(samples.iter().map(|s| ms(s.call))),
        "cachedTotalMs": distribution(samples.iter().map(|s| ms(s.prepare + s.instantiate + s.call))),
        "warmSamplesMs": samples.iter().map(|s| json!({
            "prepare": ms(s.prepare), "instantiate": ms(s.instantiate), "call": ms(s.call),
        })).collect::<Vec<_>>(),
        "budgetOverrunsMs": overruns,
        "guestLinearMemoryBytes": samples.iter().map(|s| s.memory_bytes).max(),
        "processMemoryBeforeCompile": before_compile,
        "processMemoryAfterColdCall": after_cold,
        "processMemoryAfterWarmCalls": memory_samples,
        "output": expected,
    }))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    USE_PRECOMPILED
        .set(args.iter().any(|a| a == "--precompiled"))
        .unwrap();
    REHASH.set(args.iter().any(|a| a == "--rehash")).unwrap();
    let templates_only = args.iter().any(|a| a == "--templates-only");
    if ["--rust-local-calendar", "--rust-templates", "--rust-batch"]
        .iter()
        .filter(|flag| args.iter().any(|arg| arg == **flag))
        .count()
        > 1
    {
        return Err("select only one Rust Templates variant".into());
    }
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
        .map(VerifiedComponent::new)
        .unwrap_or_else(|| {
            VerifiedComponent::from_static(if args.iter().any(|a| a == "--rust-batch") {
                TEMPLATES_BATCH
            } else if args.iter().any(|a| a == "--rust-local-calendar") {
                TEMPLATES_LOCAL
            } else if args.iter().any(|a| a == "--rust-templates") {
                TEMPLATES_RUST
            } else if args.iter().any(|a| a == "--typescript-bundled") {
                TEMPLATES_TS
            } else {
                TEMPLATES
            })
        });
    let templates = &template_bytes;
    let time_zone = args
        .iter()
        .position(|a| a == "--time-zone")
        .map(|i| args.get(i + 1).ok_or("--time-zone needs an IANA name"))
        .transpose()?;
    if args.iter().any(|a| a == "--rust-local-calendar") && time_zone.is_none() {
        return Err("--rust-local-calendar requires --time-zone matching the host timezone".into());
    }
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
    let before_engine = process_memory();
    let runtime = WasmRuntime::new(execution)?;
    let after_engine = process_memory();
    let setup = CallSetup {
        plugin_id: "com.example.probe".into(),
        ..CallSetup::default()
    };
    let mut cases = serde_json::Map::new();
    for (name, component) in [("rustEcho", RUST), ("typescriptEcho", TYPESCRIPT)] {
        if templates_only {
            continue;
        }
        cases.insert(
            name.into(),
            sample(
                &runtime,
                &VerifiedComponent::from_static(component),
                "echo",
                json!({"hello": "portable"}),
                setup.clone(),
                &cache,
                iterations,
            )?,
        );
    }
    cases.insert("templatesRender".into(), sample(&runtime, templates, "renderTemplate", json!({
        "now": "2026-07-25T10:00:00Z", "timeZone": time_zone, "locale": "de", "title": "Log {{date:YYYY}}", "body": "{{title|upper}} {{date+7d:MMMM}}"
    }), setup.clone(), &cache, iterations)?);
    if args.iter().any(|a| a == "--calendar-heavy") {
        cases.insert(
            "templatesDateHeavy".into(),
            sample(
                &runtime,
                templates,
                "renderTemplate",
                json!({
                    "now":"2026-07-25T10:00:00Z", "timeZone":time_zone, "locale":"de",
                    "title":"Log {{date:YYYY}}",
                    "body":"{{date+1M-2d:dddd, D. MMMM YYYY HH:mm:ss}}\n".repeat(20)
                }),
                setup.clone(),
                &cache,
                iterations,
            )?,
        );
    }
    if args.iter().any(|a| a == "--host-mixed") {
        if !args.iter().any(|a| {
            ["--rust-templates", "--rust-batch", "--rust-local-calendar"].contains(&a.as_str())
        }) {
            return Err("--host-mixed needs a Rust candidate".into());
        }
        let data = scratch.0.join("mixed-storage");
        std::fs::create_dir_all(&data)?;
        cases.insert(
            "hostMixed".into(),
            sample(
                &runtime,
                templates,
                "$hostProbe",
                json!({"now":"2026-07-25T10:00:00Z"}),
                CallSetup {
                    permissions: vec![
                        "notes.read".into(),
                        "pluginStorage.read".into(),
                        "pluginStorage.write".into(),
                    ],
                    notes: vec![NoteMeta {
                        id: "n0".into(),
                        title: "Mixed note".into(),
                        tags: vec![],
                        kind: "markdown".into(),
                        folder_id: None,
                        folder_path: String::new(),
                        created: String::new(),
                        modified: String::new(),
                    }],
                    data_root: Some(data),
                    ..setup.clone()
                },
                &cache,
                iterations,
            )?,
        );
    }
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
    if !templates_only {
        cases.insert(
            "typstPortable".into(),
            sample(
                &runtime,
                &VerifiedComponent::from_static(
                    if args.iter().any(|a| a == "--typescript-bundled") {
                        TYPST_TS
                    } else {
                        TYPST
                    },
                ),
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
    }

    let mut reports = Vec::new();
    for (name, component) in [("rust", RUST), ("typescript", TYPESCRIPT)] {
        if templates_only {
            continue;
        }
        eprintln!("checking {name} host contract and permission denials");
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
    if !templates_only {
        assert_eq!(
            reports[0], reports[1],
            "Rust and TypeScript host contracts differ"
        );
    }

    let mut controls = Vec::new();
    for (name, component) in [("rust", RUST), ("typescript", TYPESCRIPT)] {
        if templates_only {
            continue;
        }
        eprintln!("checking {name} cancellation");
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
        eprintln!("checking {name} timeout");
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
        eprintln!("checking {name} memory refusal");
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
    let overruns: usize = cases
        .values()
        .filter_map(|case| case["budgetOverrunsMs"].as_array())
        .map(Vec::len)
        .sum();
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "schemaVersion": 1, "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
            "execution": format!("{execution:?}"), "releaseBuild": !cfg!(debug_assertions), "iterations": iterations,
            "timeZoneInput": time_zone,
            "cases": cases, "hostReport": reports.first(), "controls": controls,
            "processMemory": process_memory, "processPss": pss,
            "processMemoryBeforeEngine": before_engine, "processMemoryAfterEngine": after_engine,
        }))?
    );
    if overruns > 0 {
        return Err(format!("{overruns} timed calls exceeded the {timeout_ms} ms budget").into());
    }
    Ok(())
}
