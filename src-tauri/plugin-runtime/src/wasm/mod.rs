//! Running a plugin's WebAssembly component.
//!
//! A `runtime: "wasm"` plugin ships one component that targets the
//! `mindstream:plugin` world in `plugin-sdk/wit`. Each call gets:
//!
//!   1. **A fresh store and instance.** Nothing a call leaves in guest memory
//!      reaches the next one. Compiling is the slow part and is cached (see
//!      [`cache`]); instantiating a cached component is copy-on-write and
//!      takes well under a millisecond.
//!   2. **Only Mindstream's imports.** A component that imports anything
//!      outside `mindstream:plugin/*`, WASI included, is refused before it
//!      runs. There is no filesystem, network, environment or clock except
//!      what the host interfaces hand out, each behind its permission.
//!   3. **A memory cap** over all of the component's linear memories together
//!      (see [`limiter`]).
//!   4. **A deadline and cancellation.** An epoch callback asks the call's
//!      [`HostContext`] whether to stop every [`ticker::TICK`], so a runaway
//!      loop ends at its deadline and a disabled plugin stops mid-call.
//!   5. **A bounded number of calls at once** (see [`MAX_CONCURRENT`]).
//!
//! The guest returns JSON. Effects in it are requests: the app validates
//! them and performs them, the same as for every other runtime.

mod batch;
pub mod bindings;
pub mod cache;
pub mod limiter;
pub mod precompiled;
pub mod ticker;

use std::path::Path;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use precompiled::{TrustedPrecompiled, VerifiedComponent};
use wasmtime::component::types::ComponentItem;
use wasmtime::component::{Component, Linker};
use wasmtime::{Engine, Store, UpdateDeadline};

use crate::error::{HostError, HostResult};
use crate::host::{CallSetup, HostContext};
use crate::limits::Limits;

use bindings::{CallState, Plugin, PluginPre};

// Match the Android NDK's ARM64 signal context. Wasmtime reads the faulting
// PC through this layout when recovering from a guest panic or memory trap.
#[cfg(all(target_os = "android", target_arch = "aarch64"))]
const _: () = assert!(std::mem::offset_of!(libc::ucontext_t, uc_mcontext) == 0xb0);

/// The interface namespace a component may import from.
pub const IMPORT_PREFIX: &str = "mindstream:plugin/";
/// Largest component accepted. A QuickJS component is 1 to 2 MiB.
pub const MAX_COMPONENT_BYTES: usize = 32 * 1024 * 1024;
/// Largest JSON a call may return. It is a copy of something already in the
/// guest's capped memory, but the host parses it, so it is bounded on its own.
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
/// How much of a guest's error message reaches the user.
pub const MAX_ERROR_CHARS: usize = 2000;
/// Calls running at once across all plugins. A call waiting on a native tool
/// holds its slot, so this also bounds concurrent tool processes.
pub const MAX_CONCURRENT: usize = 4;
/// How long a call waits for a free slot before it fails as busy.
pub const SLOT_WAIT: Duration = Duration::from_secs(5);

/// How compiled code is executed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Execution {
    /// Cranelift machine code where the host has a backend, Pulley where it
    /// does not (32-bit ARM and x86).
    #[default]
    Native,
    /// The Pulley interpreter everywhere, for testing what 32-bit Android
    /// does on any host. Needs wasmtime's `pulley` feature.
    Interpreter,
}

/// Where the time of one call went.
#[derive(Debug, Clone, Copy)]
pub struct Timings {
    pub source: cache::Source,
    /// Finding or compiling the component, and linking it.
    pub prepare: Duration,
    pub instantiate: Duration,
    /// Running the export, host calls included.
    pub call: Duration,
    /// Guest linear memory when the call finished, in bytes.
    pub memory_bytes: usize,
}

/// One call into a component.
pub struct WasmCall<'a> {
    /// The component, exactly as read from the verified package.
    pub component: &'a [u8],
    pub export: &'a str,
    pub input: &'a serde_json::Value,
    pub setup: CallSetup,
    pub limits: Limits,
    /// Total native tool time the call may add on top of `limits.timeout`.
    /// Normally [`limits::NATIVE_ALLOWANCE`].
    pub native_allowance: Duration,
    /// The on-disk compiled cache, or `None` to keep compiled code in memory
    /// only.
    pub cache_dir: Option<&'a Path>,
}

struct Prepared {
    pre: PluginPre<CallState>,
}

/// A counting semaphore for [`MAX_CONCURRENT`].
#[derive(Debug, Default)]
struct Slots {
    used: Mutex<usize>,
    freed: Condvar,
}

#[derive(Debug)]
struct Slot<'a>(&'a Slots);

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        let mut used = self.0.used.lock().unwrap_or_else(|e| e.into_inner());
        *used -= 1;
        self.0.freed.notify_one();
    }
}

impl Slots {
    fn acquire(&self, max: usize, wait: Duration) -> HostResult<Slot<'_>> {
        let deadline = Instant::now() + wait;
        let mut used = self.used.lock().unwrap_or_else(|e| e.into_inner());
        while *used >= max {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(HostError::Unavailable(
                    "the plugin runtime is busy; try again".into(),
                ));
            }
            used = self
                .freed
                .wait_timeout(used, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        *used += 1;
        Ok(Slot(self))
    }
}

/// The engine, linker and caches every call shares.
pub struct WasmRuntime {
    engine: Engine,
    linker: Linker<CallState>,
    compiled: Mutex<cache::Lru<Prepared>>,
    compiling: Mutex<()>,
    ticker: ticker::Ticker,
    slots: Slots,
    max_concurrent: usize,
}

static GLOBAL: OnceLock<Result<WasmRuntime, String>> = OnceLock::new();

impl WasmRuntime {
    pub fn new(execution: Execution) -> HostResult<Self> {
        let target = if execution == Execution::Interpreter {
            if cfg!(target_pointer_width = "64") {
                "pulley64"
            } else {
                "pulley32"
            }
        } else {
            env!("MINDSTREAM_WASM_TARGET")
        };
        let engine = precompiled::engine_for_target(target)
            .map_err(|e| HostError::Unavailable(format!("plugin runtime: {e}")))?;
        let mut linker = Linker::new(&engine);
        Plugin::add_to_linker::<CallState, wasmtime::component::HasSelf<CallState>>(
            &mut linker,
            |state| state,
        )
        .map_err(|e| HostError::Unavailable(format!("plugin runtime: {e}")))?;
        let ticker = ticker::Ticker::start(&engine)?;
        Ok(Self {
            engine,
            linker,
            compiled: Mutex::new(cache::Lru::new(cache::MEMORY_ENTRIES)),
            compiling: Mutex::new(()),
            ticker,
            slots: Slots::default(),
            max_concurrent: MAX_CONCURRENT,
        })
    }

    /// The runtime the app uses, created on first use. Nothing is compiled
    /// or started until a Wasm plugin is first called.
    pub fn global() -> HostResult<&'static WasmRuntime> {
        GLOBAL
            .get_or_init(|| WasmRuntime::new(Execution::Native).map_err(|e| e.to_string()))
            .as_ref()
            .map_err(|e| HostError::Unavailable(e.clone()))
    }

    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    /// Calls running right now.
    pub fn running(&self) -> usize {
        self.ticker.running()
    }

    /// Forget every compiled component held in memory. The disk cache stays.
    pub fn clear_memory_cache(&self) {
        self.compiled
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    /// Check a component without running it: it compiles, it imports only
    /// what the host provides, and it exports `invoke`.
    pub fn validate(&self, component: &[u8]) -> HostResult<()> {
        self.prepare(component, None).map(drop)
    }

    fn prepare(
        &self,
        bytes: &[u8],
        cache_dir: Option<&Path>,
    ) -> HostResult<(Arc<Prepared>, cache::Source)> {
        self.prepare_verified(bytes, None, None, cache_dir)
    }

    /// Compile/link verified bytes in a worker without instantiating or executing a guest.
    pub fn prepare_component(
        &self,
        component: &VerifiedComponent,
        cache_dir: Option<&Path>,
        bundled: Option<&TrustedPrecompiled<'_>>,
    ) -> HostResult<cache::Source> {
        self.prepare_verified(component, Some(component), bundled, cache_dir)
            .map(|(_, source)| source)
    }

    fn prepare_verified(
        &self,
        bytes: &[u8],
        verified: Option<&VerifiedComponent>,
        bundled: Option<&TrustedPrecompiled<'_>>,
        cache_dir: Option<&Path>,
    ) -> HostResult<(Arc<Prepared>, cache::Source)> {
        if bytes.len() > MAX_COMPONENT_BYTES {
            return Err(HostError::Invalid(format!(
                "plugin component is {} bytes, more than the {MAX_COMPONENT_BYTES} allowed",
                bytes.len()
            )));
        }
        // Only reuse the digest of the exact immutable buffer supplied here.
        let key = verified
            .filter(|v| std::ptr::eq(bytes, v.as_slice()))
            .map_or_else(|| cache::digest(bytes), VerifiedComponent::digest);
        if let Some(found) = self.lookup(&key) {
            return Ok((found, cache::Source::Memory));
        }
        // One compile at a time, and the second caller of the same component
        // finds the first one's result rather than compiling it again.
        let _compiling = self.compiling.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(found) = self.lookup(&key) {
            return Ok((found, cache::Source::Memory));
        }
        let disk = cache_dir.map(|dir| cache::Disk::new(dir, &self.engine));
        let from_bundle = || {
            let bytes = bundled?.decode(key, &self.engine)?;
            if let Some(disk) = &disk {
                disk.store(&key, &bytes);
                if let Some(component) = disk.load(&self.engine, &key) {
                    return Some(component);
                }
            }
            // SAFETY: TrustedPrecompiled's constructor requires code from our
            // build pipeline. decode checked its source, engine and code hash.
            unsafe { Component::deserialize(&self.engine, &bytes) }.ok()
        };
        let (component, source) = match disk.as_ref().and_then(|d| d.load(&self.engine, &key)) {
            Some(component) => (component, cache::Source::Disk),
            None if bundled.is_some() => match from_bundle() {
                Some(component) => (component, cache::Source::Bundled),
                None => (
                    Component::new(&self.engine, bytes).map_err(|e| {
                        HostError::Invalid(format!("not a valid plugin component: {e}"))
                    })?,
                    cache::Source::Compiled,
                ),
            },
            None => {
                let component = Component::new(&self.engine, bytes).map_err(|e| {
                    HostError::Invalid(format!("not a valid plugin component: {e}"))
                })?;
                (component, cache::Source::Compiled)
            }
        };
        self.check_imports(&component)?;
        let instance_pre = self
            .linker
            .instantiate_pre(&component)
            .map_err(|e| HostError::Invalid(format!("plugin component cannot be linked: {e}")))?;
        let pre = PluginPre::new(instance_pre).map_err(|e| {
            HostError::Invalid(format!(
                "plugin component does not export `invoke` as the mindstream:plugin world defines it: {e}"
            ))
        })?;
        if source == cache::Source::Compiled {
            if let Some(disk) = &disk {
                match component.serialize() {
                    Ok(compiled) => disk.store(&key, &compiled),
                    Err(e) => log::warn!("[plugins] could not serialize a compiled plugin: {e}"),
                }
            }
        }
        let prepared = Arc::new(Prepared { pre });
        self.compiled
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, prepared.clone());
        Ok((prepared, source))
    }

    fn lookup(&self, key: &cache::Digest32) -> Option<Arc<Prepared>> {
        self.compiled
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
    }

    /// Refuse a component that imports anything Mindstream does not provide,
    /// naming every such import. Linking would fail on the first one with a
    /// message about types; this says what the author has to change.
    fn check_imports(&self, component: &Component) -> HostResult<()> {
        let ty = component.component_type();
        let foreign: Vec<String> = ty
            .imports(&self.engine)
            .filter(|(name, item)| {
                !(name.starts_with(IMPORT_PREFIX)
                    && matches!(item.ty, ComponentItem::ComponentInstance(_)))
            })
            .map(|(name, _)| name.to_string())
            .collect();
        if foreign.is_empty() {
            return Ok(());
        }
        Err(HostError::Invalid(format!(
            "plugin component imports {}, which Mindstream does not provide. A plugin may \
             import only mindstream:plugin interfaces: build it without WASI (the SDK's \
             build does this)",
            foreign.join(", ")
        )))
    }

    /// Run one export and return its JSON result.
    pub fn invoke(&self, call: WasmCall<'_>) -> HostResult<serde_json::Value> {
        self.invoke_timed(call).map(|(value, _)| value)
    }

    /// [`invoke`](Self::invoke), reporting where the time went.
    pub fn invoke_timed(&self, call: WasmCall<'_>) -> HostResult<(serde_json::Value, Timings)> {
        self.invoke_verified_timed(call, None, None)
    }

    pub fn invoke_verified_timed(
        &self,
        call: WasmCall<'_>,
        verified: Option<&VerifiedComponent>,
        bundled: Option<&TrustedPrecompiled<'_>>,
    ) -> HostResult<(serde_json::Value, Timings)> {
        let plugin_id = call.setup.plugin_id.clone();
        let fail = |detail: String| HostError::Invalid(format!("wasm ({plugin_id}): {detail}"));

        let started = Instant::now();
        let _slot = self.slots.acquire(self.max_concurrent, SLOT_WAIT)?;
        let (prepared, source) =
            self.prepare_verified(call.component, verified, bundled, call.cache_dir)?;
        let prepare = started.elapsed();

        let input = serde_json::to_string(call.input)
            .map_err(|e| fail(format!("input is not serializable: {e}")))?;
        let host = HostContext::new(call.setup, call.limits, call.native_allowance);
        let mut store = Store::new(
            &self.engine,
            CallState {
                host,
                limiter: limiter::CallLimiter::new(call.limits.memory_bytes),
            },
        );
        store.limiter(|state| &mut state.limiter);
        store.set_epoch_deadline(1);
        store.epoch_deadline_callback(|ctx| {
            ctx.data().host.check().map_err(wasmtime::Error::new)?;
            Ok(UpdateDeadline::Continue(1))
        });

        let _running = self.ticker.enter();
        let instantiated = Instant::now();
        let instance = prepared.pre.instantiate(&mut store);
        let instantiate = instantiated.elapsed();
        let called = Instant::now();
        let result = instance.and_then(|i| i.call_invoke(&mut store, call.export, &input));
        let call_time = called.elapsed();
        let state = store.data();
        let timings = Timings {
            source,
            prepare,
            instantiate,
            call: call_time,
            memory_bytes: state.limiter.memory_total(),
        };

        // A stop the host asked for wins over whatever the guest made of it.
        let stopped = state.host.check();
        #[cfg(test)]
        if call.export == "report" || stopped.is_err() {
            eprintln!(
                "wasm export {}: prepare={:?}, instantiate={:?}, call={:?}, guest_memory={} bytes",
                call.export,
                timings.prepare,
                timings.instantiate,
                timings.call,
                timings.memory_bytes
            );
        }
        stopped?;
        let out_of_memory = || {
            format!(
                "ran out of memory at its {} MiB limit",
                state.limiter.memory_limit() / (1024 * 1024)
            )
        };
        let output = match result {
            Ok(Ok(output)) => output,
            Ok(Err(message)) => {
                let message: String = message.chars().take(MAX_ERROR_CHARS).collect();
                return Err(fail(if state.limiter.exhausted() {
                    format!("{} ({message})", out_of_memory())
                } else {
                    message
                }));
            }
            Err(trap) => {
                return Err(match trap.downcast::<HostError>() {
                    // Raised by the host to stop the call, including a tool
                    // run refused for lack of time just before the deadline.
                    Ok(stop) if stop.is_fatal() => stop,
                    Ok(refusal) => fail(refusal.to_string()),
                    Err(_) if state.limiter.exhausted() => fail(out_of_memory()),
                    Err(trap) => fail(format!("plugin crashed: {}", describe_trap(&trap))),
                });
            }
        };
        if output.len() > MAX_OUTPUT_BYTES {
            return Err(fail(format!(
                "returned {} bytes, more than the {MAX_OUTPUT_BYTES} allowed",
                output.len()
            )));
        }
        let value = serde_json::from_str(&output)
            .map_err(|e| fail(format!("returned something that is not JSON: {e}")))?;
        Ok((value, timings))
    }
}

/// A trap in one line. The first line of the report names the trap; the rest
/// is a backtrace of function indices that means nothing to a user.
fn describe_trap(trap: &wasmtime::Error) -> String {
    let report = format!("{trap:#}");
    let first = report.lines().next().unwrap_or("trapped").to_string();
    match trap.chain().last().map(|c| c.to_string()) {
        Some(cause) if cause != first && !first.contains(&cause) => format!("{first}: {cause}"),
        _ => first,
    }
}

#[cfg(test)]
mod tests;
