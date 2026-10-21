# Wasm plugin migration gates

The migration has a working Wasmtime runner and a language-agnostic WIT
component contract. Shipped Templates and Typst now use compiled Rust, with
TypeScript/QuickJS implementations retained as non-shipped examples. Physical
Android ARM64 runtime and app tests have evidence, but M5 remains open. Trusted
bundled precompilation and immutable builtin digest reuse reduce preparation
and app-call costs. Earlier macOS TypeScript interpreter runs exceeded the
unchanged one-second budget; the new Rust selection needs its own platform
evidence. Desktop whole-app measurements remain incomplete. M6 is blocked.
Luau runtime support and bindings remain; old bundled sources are retained
outside the embedded plugin tree for regression comparisons.

## Milestone status

| Milestone                  | Evidence                                                                                                                                                              | Remaining work                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| M0, inventory and baseline | Host/API inventory; Linux Luau measurements; matching normal Android app builds                                                                                       | Representative desktop whole-app baseline and longer device memory runs                                                           |
| M1, shared host services   | Runtime-neutral crate; existing Luau host tests                                                                                                                       | None identified                                                                                                                   |
| M2, Wasmtime integration   | Verified entry bytes, compile caches, fresh stores, limits, cancellation, permission tests                                                                            | Cross-platform release gate below                                                                                                 |
| M3, TypeScript SDK         | Packed Node-only author workflow; all three desktop Node 22 CI jobs passed after the Windows temporary-path fix                                                       | None identified                                                                                                                   |
| M4, bundled ports          | Rust Templates and Typst use manifest v2/Wasm; shared TypeScript example tests and app-host tests; template output compared with retained Luau                        | New artifact platform gates remain under M5                                                                                       |
| M5, parity and performance | Physical Android native/Pulley probes, trusted AOT and Rust Templates comparison, release app lifecycle, matching APK/startup/memory measurements, desktop CI results | macOS interpreter budget reliability, representative app startup/memory and installer measurements, broader thermal/soak coverage |
| M6, retire Luau            | Intentionally pending                                                                                                                                                 | All M5 gates must pass first                                                                                                      |

The npm SDK stays private during migration. It can be packed and installed
locally. This is not an SDK v1 compatibility promise. The ABI is
`mindstream:plugin@0.1.0`; manifest v2 intentionally rejects Luau. Both manifest
versions still accept manifest-only packages.

## Execution inventory

| Path                         | Entry points or responsibilities                                                                         | Verification                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Templates                    | `newFromTemplate`, `renderTemplate`; nested folder/tag selection; date math, variables, filters, UUIDs   | `plugin-sdk/bundled/bundled.test.ts`; app-host template regression tests                                   |
| Typst                        | `renderDocument`, `exportDocument`; stdin to declared `typst`, PDF bytes and stderr diagnostics          | Built-component tests for success/failure/timeout, source-only fallback through the app host               |
| LanguageTool                 | Manifest-only text-checker and native-service contributions                                              | Existing manifest, diagnostics, source-editor and E2E tests                                                |
| `plugins::run_plugin_script` | Dispatch Luau/Wasm after package approval; verified component bytes; backend context merge               | App plugin tests including checksum changes, permissions and v2 entry discovery                            |
| Luau adapter                 | Fresh VM, plugin-scoped module loading and old entry contract                                            | Retained `src-tauri/src/plugins/luau.rs` tests                                                             |
| Wasm adapter                 | Shared engine, memory/disk cache, bounded concurrency, fresh stores, JSON ABI, epoch interruption        | `src-tauri/plugin-runtime/src/wasm/tests.rs`, both Rust/TypeScript fixtures and Pulley                     |
| Host services                | Dates, frontmatter, logging, note metadata, isolated storage, native processes, limits and cancellation  | Runtime crate tests, called by both adapters                                                               |
| Declarative effects          | `none`, `toast`, `createNote`, `createNoteFromNote`, `insertMarkdown`, `openMenu`                        | Frontend effect validation and existing menu/template tests                                                |
| Lifecycle                    | Disable, crash, package update/reapproval and removal cancel active calls; fresh stores after completion | Cancellation registry, native-process and Wasm tests; physical Android lifecycle assertions recorded below |

| WIT interface  | Permission boundary                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| `runtime`      | Logging, UUID, random bytes and permission inspection are always available and bounded                       |
| `clock`        | Host time, date formatting and checked date arithmetic need no grant                                         |
| `markdown`     | Frontmatter serialization needs no grant                                                                     |
| `notes`        | Every metadata read requires `notes.read`; note bodies are never exposed                                     |
| `storage`      | `pluginStorage.read` for read/list; `pluginStorage.write` for write/delete; containment and file-size checks |
| `native-tools` | `nativeTools.runDeclared` plus a manifest declaration; host chooses the executable                           |

Effects that create notes still require `notes.create`. Other unchanged host
capabilities are `textCheckers.contribute`, `pluginArtifacts.download` and
`nativeServices.run`. Signatures, package digests and per-vault approvals remain
host-owned. Installed packages start gated. An update with new permissions
requires review even when the signer is unchanged.

Future AI/OCR capability design reserves `mindstream:ai` and `mindstream:ocr`
for host-owned operations. They are not WIT imports or implemented SDK APIs.
Use opaque model/attachment IDs, separate user grants, bounded results and
cancellable job handles if these capabilities are added. Model loading and
inference stay outside guest linear memory.

## Available baseline evidence

Measured on this Linux x86_64 development machine on 2026-10-20, before the
runtime migration, at app commit `2bdba0b4`. Release profile uses size
optimization, LTO and stripping.

| Luau operation             |      p50 |      p95 |
| -------------------------- | -------: | -------: |
| Empty export with fresh VM | 0.283 ms | 0.305 ms |
| Templates `renderTemplate` | 0.419 ms | 0.611 ms |
| Templates menu, 500 notes  | 2.609 ms | 2.767 ms |

A baseline Rust app binary measured 22,311,536 bytes stripped and 9,515,023
bytes gzipped. That build embedded a stub frontend. It is not an installer
measurement, and must only be compared with a build using the same stub,
features, target and toolchain. The later normal Android app pair is reported
separately below.
The scratch timing experiment is historical evidence, not a committed baseline
benchmark that CI can reproduce. Repeat representative whole-app measurements
before approving the gate.

The initial standalone toolchain experiment found substantially smaller
QuickJS components than StarlingMonkey, so the SDK uses `componentize-qjs`
with its size-optimized engine by default. The bundled Templates plugin uses
the faster QuickJS engine to fit its 500-note menu within the default one-second
budget under Pulley. Typst retains the smaller engine. Runtime limits apply to
summed guest linear memory; process RSS/PSS and compiled-cache memory must be
measured separately.

## Recorded Linux Wasm measurements

The [JSON report](benchmarks/wasm-plugin-linux-x86_64.json) records the component
hashes, toolchain, host reports, guest linear memory and timing distributions.
The current release-mode samples used an idle development machine, with
100 calls per case and the app's one-second budget. They do not close the
representative-hardware gate. Earlier size-optimized samples are retained
separately, with their concurrent-build conditions recorded.

| Case                       | Native call p95 | Pulley call p95 | Guest memory |
| -------------------------- | --------------: | --------------: | -----------: |
| TypeScript echo            |         0.16 ms |         0.55 ms |     1.50 MiB |
| Templates render           |         0.42 ms |         3.02 ms |     1.44 MiB |
| Templates menu, 500 notes  |        14.79 ms |       439.23 ms |     1.75 MiB |
| Typst source-only fallback |         0.17 ms |         0.77 ms |     1.44 MiB |

The largest p95 instantiation time was 0.30 ms. Cancellation completed in
30 to 35 ms and the requested 100 ms timeout fired in about 102 to 107 ms.
Both guest languages stopped at a 4 MiB memory cap. Cold compilation and disk
cache loads are reported separately in the JSON. Process memory includes
compiled components and compiler state and is separate from guest memory.

## Repeatable checks

From the repository root:

Use Node.js 22.11 or later for SDK checks. Node 20's default Wasm engine
rejects the extended constant expressions in the QuickJS components. The
desktop and release workflows use Node 22.

```sh
pnpm install --frozen-lockfile
pnpm --filter @mindstream/plugin-sdk typecheck
npm run test:plugin-author
pnpm plugins:build
node plugin-sdk/conformance/build.mjs --ts
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml --locked --workspace
cargo run --manifest-path src-tauri/Cargo.toml --locked --release -p mindstream-plugin-runtime --example plugin-bench > plugin-native.json
cargo run --manifest-path src-tauri/Cargo.toml --locked --release -p mindstream-plugin-runtime --example plugin-bench -- --interpreter > plugin-interpreter.json
```

The author check removes directories containing Cargo/rustc from PATH, packs
the SDK including WIT, then uses only Node/npm in a temporary project. The
Rust starter is verified separately using `plugin-sdk/rust/create.mjs`.

The runtime probe executes the committed Rust and TypeScript components,
compares host reports and permission denials, checks cancellation, timeout and
memory refusal, and measures cached invocation separately from cold compile
and disk-cache load. It also measures Templates rendering and a 500-note menu,
and Typst's portable source-only behavior. `--iterations N` changes the default
100 samples. Timed workloads use the app's one-second default. For engine
comparisons, `--templates-component /path/to/plugin.wasm` selects different
Templates bytes and `--timeout-ms 5000` allows an expensive case to report
its cost up to the host ceiling. These flags do not change bundled manifests
or app defaults. Dedicated timeout checks still request 100 ms. Component
SHA-256 hashes identify the measured bytes.
Release mode is recorded in the JSON report. Debug timings do not count.

The size-optimized Templates engine exceeded the one-second budget under
Pulley. The bundled build now selects the faster engine. The report retains
the original size-optimized measurements, taken with a five-second allowance,
for comparison. Desktop Pulley measurements still do not replace the required
physical Android run. The faster Templates component is 1,727,495 bytes,
540,607 bytes larger than the size-optimized component. Guest linear memory
was unchanged in these workloads. The slowest menu call in the current Pulley
run took 477.84 ms. The earlier size-optimized run exceeded one second, but
its concurrent-build conditions prevent a controlled speedup comparison.

The desktop `plugin-runtime` CI job uploads native and interpreter reports on
Linux, macOS and Windows. The Rust job tests the whole workspace, including
both guest languages. The JS matrix checks the packed author workflow.
CI results must be collected before marking any unobserved platform passed.

## Physical Android ARM64 procedure

Use a physical mid-range device. A desktop Pulley run checks interpreter
behavior, and an emulator can find integration bugs; neither satisfies this
gate. `ANDROID_SERIAL` selects the device for the runner.

Install the Android NDK, platform tools and the Rust `aarch64-linux-android`
target. On a Linux build machine, set the NDK toolchain directory for the
installed NDK version, then build the standalone probe:

Android builds require `libc >= 0.2.190`. Earlier versions omit ARM64
signal-context padding used by Wasmtime's trap handler. Guest panic and
allocation refusal then crash the process with `SIGILL`. The runtime checks
the NDK's `uc_mcontext` offset at compile time. See the
[upstream layout fix](https://github.com/rust-lang/libc/pull/5189).

```sh
export ANDROID_TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$ANDROID_TOOLCHAIN/aarch64-linux-android26-clang"
export CC_aarch64_linux_android="$ANDROID_TOOLCHAIN/aarch64-linux-android26-clang"
export AR_aarch64_linux_android="$ANDROID_TOOLCHAIN/llvm-ar"
cargo build --manifest-path src-tauri/Cargo.toml --locked --release --target aarch64-linux-android -p mindstream-plugin-runtime --example plugin-bench
node plugin-sdk/android-runner.mjs src-tauri/target/aarch64-linux-android/release/examples/plugin-bench > plugin-android-console.txt
```

The runner copies only the executable to a unique `/data/local/tmp` directory,
sets `TMPDIR` to that writable directory, runs it, and removes its files.
Components are embedded unchanged in the executable. The console report
contains adb transfer output as well as the probe JSON; retain it as raw
evidence. Run the same probe with `--interpreter` to compare execution paths.
To run the crate's test executable on-device, set Cargo's target runner to
`["node", "/absolute/path/to/plugin-sdk/android-runner.mjs"]` through a local
Cargo config, then use `cargo test --target aarch64-linux-android -p
mindstream-plugin-runtime` with the same linker environment.

Also install a release app and test the same signed plugin folder on desktop
and Android. Confirm approval, settings, notes, storage and effects, then
cancel calls by disabling/removing the plugin, closing the vault, and
backgrounding/restoring the app. Typst must remain source-editable when its
native tools/services are unavailable. Measure app startup with no guest
initialization, cold compilation, warm calls, idle RSS/PSS, APK/AAB size and
process memory after repeated calls. Record device model, Android version,
CPU, toolchain, artifact hashes and thermal/power state with the results.

## Local validation

The Windows frontend suite passed 3,580 tests in 300 files under Node 22.
All 24 SDK/bundled tests passed. The Windows Rust workspace passed 1,038 app
tests with six ignored, its integration suites and 70 runtime tests. The
physical Android runtime passed 75 tests, including interpreter cases. The
final bundled components also passed their app-host regression checks.

The production web build and Svelte type check passed. Rustfmt, clippy with
warnings denied, ESLint, theme/i18n lint and CI-filter tests passed. The
17 selected browser plugin/source-editor tests passed. The packaged Tauri
plugin suite passed all four tests, including the Wasm export through IPC and
enable/disable persistence across restart. Both the Node-only packed SDK
workflow and a fresh Rust starter build succeeded.

The earlier Android toolchain blocker is resolved. See the M5 device and CI
results below. The Windows packaged plugin checks passed five tests, then the
exact signed Android fixture passed the added lifecycle test.

## M5 device and cross-platform results, 2026-10-20

The [evidence report](benchmarks/wasm-m5-2026-10-20/README.md) links raw logs,
per-call samples, toolchains, hashes, source patches, screenshots and CI runs.
The physical device was a Samsung SM-T733, Android 14/API 34, SM7325, ARM64.
It was USB charging with battery saver off and thermal status 0. Battery rose
from 5% to 10%; recorded battery temperatures were about 29.1 to 31.7 C. The
operator reported normal temperatures. Ambient temperature, case and external
cooling were not measured. These low-charge, sequential runs do not establish
performance across power and thermal states.

Both native and `--interpreter` release probes completed 100 samples per case
with the default 1,000 ms budget through `plugin-sdk/android-runner.mjs`.
No budget was raised. Guest call p95 and full cached preparation plus instance
plus call p95 differ substantially:

| Android ARM64 case        | Native guest p95 | Pulley guest p95 | Native cached total p95 | Pulley cached total p95 |
| ------------------------- | ---------------: | ---------------: | ----------------------: | ----------------------: |
| Rust echo                 |         0.043 ms |         0.064 ms |                 2.03 ms |                 0.90 ms |
| TypeScript echo           |         0.121 ms |         0.640 ms |                 8.16 ms |                 8.81 ms |
| Templates render          |         0.337 ms |         4.114 ms |                11.51 ms |                15.39 ms |
| Templates menu, 500 notes |         25.27 ms |        803.85 ms |                36.43 ms |               815.13 ms |
| Typst source-only         |         0.123 ms |         0.959 ms |                 7.68 ms |                 8.65 ms |

Instantiation p95 remained below 0.7 ms. Native cold preparation ranged from
122 to 999 ms; Pulley from 150 to 1,075 ms. Compilation is outside the guest
execution budget. Both languages refused allocation at 4 MiB, cancelled in
about 34 ms and recovered. Workload guest memory was at most 1.75 MiB, distinct
from process memory. The 32 MiB default has headroom for these cases but still
needs representative third-party workload evidence. An additional ARMv7
interpreter run on the same tablet completed 100 samples at the default budget;
its menu guest p95 was 900.78 ms. This is not evidence from a physical ARMv7 CPU.

The normal release app created a separate Templates note with interpolated
date/title after setting the template folder. Typst source editing worked
without native tools. A release variant with `tauri/devtools` enabled allowed
the same signed conformance package to be installed, approved and exercised
through app IPC on Android and Windows. Android hides package installation in
its UI; this verifies the backend path, not a mobile installation UI.

Android disable/remove cancelled runaway calls, frames continued, another
plugin completed, and calls recovered after re-enable. Background/resume kept
the process alive and the runaway stopped at the default budget. It did not
demonstrate immediate cancellation on backgrounding. Switching vaults during a
runaway restarted the process and preserved approval isolation. Immediate
background cancellation remains unverified if required by the release policy.

Matching normal frontend ARM64 release APKs compared pre-migration `2bdba0b4`
with migration `9115b342` plus the Android file-lock fix. Both include the same
startup compatibility fixes and use separate disposable app IDs. The signed
APK grew from 40,931,879 to 51,256,335 bytes, a 10,324,456-byte increase.
The native library grew by the same amount. This pair meets the 15 MB size
target for this ARM64 APK; AAB delivery and other ABI/desktop packages remain
unmeasured. The historical stub-frontend build is excluded.

Matching normal Windows x86_64 MSVC executables at `2bdba0b4` plus the shared
compatibility fixes and `436f9b10` measured 31,163,392 and 42,630,656 bytes.
Both use real normal frontends, release opt-level `s`, LTO and stripping, built
through the same Tauri CLI without test features. The 11,467,264-byte delta
meets the 15 MB uncompressed target for this executable pair. Installer and
macOS bundle sizes, and desktop startup/process memory, remain unmeasured.

Five cold Android activity draws measured medians of 186 ms for Luau and
199 ms for migration. `am start -W TotalTime` is initial activity draw, not
interactive-ready time or plugin initialization. After 60 seconds idle, PSS
was 128,714 versus 122,894 KiB. The first Templates call reached sampled PSS
137,755 versus 206,607 KiB; process VmHWM was 152,640 versus 270,436 KiB after
30 calls. Calls 10 through 30 added 591 versus 646 KiB PSS. After 20 seconds
idle, PSS was 140,213 versus 153,311 KiB. This short run does not prove absence
of retained memory. Dumpsys RSS and per-process VmHWM use different accounting.

The matching devtools release variants also measured 100 app IPC calls per
case. Templates render p95 was 12.3 ms with Luau and 58.6 ms with Wasm.
First calls in cleared apps took 217.2 and 1,064.5 ms; first calls after restart
took 11.1 and 70.5 ms. The runtime already exceeds the 5 ms cached-total target
for larger components. App discovery collects, hashes and verifies package
bytes on each call, and clones the Wasm entry before dispatch. That code is a
profiling lead, not an isolated attribution of the whole measured regression.
Do not weaken checksum/approval checks to satisfy the timing target.

Desktop Rust CI passed on Windows, macOS and Linux at `9115b342`. Linux/macOS
Node 22 checks and all packaged-app suites passed. Windows JS failed because
Vitest loaded an encoded Windows 8.3 TEMP path; canonicalizing the temp root
fixed the locally reproduced 15-test failure. The macOS Pulley 500-note menu
exceeded 1,000 ms in that run. An earlier macOS run passed, but does not erase
the failure. The probe now records overrun attempts, emits JSON and exits
unsuccessfully, and CI uploads reports even when a timed call fails. The final
rerun at `436f9b10` passed all three Node 22 jobs and all three portable runtime
jobs. Its macOS interpreter menu guest p95 was 621.63 ms, max 777.64 ms, with
zero interrupted calls. That passing rerun does not explain the preceding
budget failure. Full status and source revisions are in the evidence report.
The complete rerun finished successfully, including all three Linux packaged-app
suites. This CI pass does not close the remaining app performance and hardware
measurement gates.

At that checkpoint M5 stayed open for cached/app-call performance, macOS budget reliability,
desktop startup/memory and matching installer sizes, broader device conditions
and memory retention, and any required immediate background cancellation.
No untested platform or missing release measurement is marked passed.

## Preparation and Rust Templates follow-up, 2026-10-21

The [optimization report](benchmarks/wasm-optimization-2026-10-21/README.md)
records implementation `3b070fcf`, probe controls `9c211cad`, final CI
`8b02e37a`, raw samples, conditions, artifact hashes and reproduction steps.
Only the app's own build can supply trusted native artifacts. Missing or
incompatible artifacts compile the portable component. Third-party packages
retain integrity and approval checks and never supply deserializable native
code. Enabled, approved plugins prepare in a bounded background queue without
executing guests. Builtin digest reuse is tied to immutable embedded bytes.
Every call still uses a fresh store and instance.

The same physical SM-T733 passed 78 release runtime tests. Both native and
Pulley release probes retained 100 samples and the default 1,000 ms budget.
Two native AOT workloads also completed 1,000 calls per export. No budget was
raised. The Rust Templates prototype stays separate from the production
TypeScript plugin and passes the recorded parity fixtures, including release
interpreter execution. It is not a completed replacement decision.

Native TypeScript AOT cold preparation measured 58.65 ms, and Rust AOT
16.75 ms. Warm native Templates render total p95 was 0.56 ms for TypeScript
and 0.16 ms for Rust. The 500-note menu measured 25.68 versus 2.70 ms native,
and 801.26 versus 51.30 ms with Pulley. These include runtime preparation,
instantiation and guest execution but exclude app discovery and IPC. Cold
preparation is one observation per case, not an initialization percentile.
The report separates compiler memory, process RSS/PSS and guest linear memory.
Rust reduced component size from 1,727,495 to 121,628 bytes, while its menu
used 2 MiB guest memory versus TypeScript's 1.75 MiB. A smaller component does
not guarantee less guest memory for every export.

The optimized devtools release measured app render IPC p95 of 11.4 ms over
100 calls, compared with the earlier migration's 58.6 ms and Luau's 12.3 ms.
Those earlier blocks had different charge levels and are contextual comparisons,
not controlled attribution of every improvement. Discovery had already prepared
the component before the first timed export. Normal frontend portable and AOT
release apps were paired again at 30% charge, USB charging, saver off and
thermal status 0. Initial process VmHWM was 270,972 versus 166,976 KiB; idle
PSS was 139,042 versus 139,725 KiB. AOT reduces the observed compilation peak,
not steady app memory. Five activity draws had medians 211 versus 194 ms;
interactive-ready startup remains unmeasured. App memory after 30 calls and
1,000-call runtime checkpoints do not close the broader retention gate.

The unset-source Templates toast was used only for repeated-call memory
measurement. In the release variant, selecting a real template folder in
Settings then using the actual New from template menu created a separate
`Daily 2026-10-21` note with substituted title/date and left the source intact.
A Typst template created a separate plugin-owned note. After enabling Typst in
Settings, source editing and persistence worked without the native compiler.
The signed fixture passed all 15 Android lifecycle assertions again, including
storage, effects, disable/remove cancellation, responsiveness, recovery and
vault approval isolation. Backgrounding still demonstrated deadline-based
termination, not immediate cancellation.

Matching normal AOT APK and Windows executable increases over the normal Luau
baseline are 13,348,144 and 14,851,584 bytes. Both measured pairs stay below
15,000,000 bytes, with only 148,416 bytes of Windows margin. The AOT additions
over portable controls are 2,978,208 and 3,348,480 bytes. The historical stub
frontend baseline remains excluded; installers, macOS bundles, AAB delivery
and other ABIs remain unmeasured.

Full CI run 39515421160 passed all Windows/macOS/Linux Rust, Node 22 and runtime
jobs and all Linux packaged-app suites. Functional debug tests now run serially
after compiler fixtures starved an existing interpreter deadline check on two
runners. This does not explain the separate macOS release probe failure in
39513934906, where ten TypeScript interpreter menu attempts exceeded budget.
Its passing rerun had guest p95 605.59 ms and max 649.49 ms. Keep the failure as
an unresolved reliability gate. Runner power, thermals and CPU allocation were
uncontrolled. M5 remains open for that gate, representative desktop app and
package measurements, broader device conditions and memory retention, and any
required immediate background cancellation. M6 remains blocked; retain Luau.

## Guest-local calendar candidate, 2026-10-21

The [calendar comparison](benchmarks/wasm-local-calendar-2026-10-21/README.md)
adds a second Rust Wasm candidate with no calendar Host API calls. It embeds
IANA timezone data and requires an explicit `timeZone` input. Both Rust
variants and TypeScript completed all twelve physical Android native/Pulley,
portable/AOT combinations with 100 samples per case, unchanged 1,000 ms budgets,
matching outputs and no interrupted attempts. Seven guest tests and all 73
Windows runtime tests passed. New candidate desktop release and whole-app
measurements remain untested.

For AOT date-heavy rendering, moving dates into the guest reduced native total
p95 from 0.538 to 0.387 ms, but increased Pulley from 1.496 to 11.152 ms. The
candidate adds 925,284 portable bytes and 0.8125 MiB guest linear memory; its
menu reaches 2.8125 MiB. Ordinary native rendering differed by only about
0.006 ms. Host imports run native code even under Pulley, so fewer imports do
not imply less execution time. Keep the host-backed Rust prototype as the
preferred comparison candidate for the shared native/interpreter path.
The local variant stays experimental: it needs timezone context integration,
a timezone-database update policy, broader parity and release measurements.
Production TypeScript and retained Luau are unchanged; M5/M6 remain open.

## General host batch experiment, 2026-10-21

The [general batch comparison](benchmarks/wasm-host-batch-2026-10-21/README.md)
adds a typed bounded transport over all 17 existing Wasm host operations.
Backward text references carry results across interfaces. Scalar capability
checks and limits still apply; the first error stops later operations, earlier
side effects remain, and deadlines/cancellation trap the guest. The
[design guide](plugin-host-api-design.md) documents the contract, SDK example,
external precedents and host-versus-guest recommendations.

Twenty physical ARM64 release probe processes completed 100 samples per case
at the unchanged 1,000 ms budget, with matching outputs and zero interrupted
attempts. Three paired AOT rounds found scalar versus batch interpreter p95
ranges of 1.537-1.558 versus 2.338-2.343 ms for date-heavy rendering. Later
paired mixed-workload rounds improved interpreter p95 from about 2.064 to
1.912-1.922 ms. The first scalar mixed run had a larger p95; all runs remain
in the evidence. Native mixed improvements were small, and ordinary native
microsecond timings varied. Fewer boundary crossings did not predict lower
total CPU cost. Keep batching explicit and opt-in, and retain scalar APIs.

Windows workspace/app checks and the final 82-test runtime suite passed. An
intermediate existing debug interpreter deadline failure during host builds
is retained with the passing quiet rerun; it is not explained away. The new
host code has not yet had new macOS/Linux release, physical app, startup,
package or long-retention measurements. Earlier size pairs do not validate
this added host API. New batch-importing guests require a supporting host;
the ABI/SDK remain private. Shipped Templates selection and Luau remain.
M5/M6 stay open.

The subsequent recovery update adds `phase`, `completed` and earlier kept
`replies` alongside the stopping command index/cause. Whole-plan validation
failure now clearly reports that nothing ran; execution errors and rejected
oversized results report different progress. Side effects are not rolled back,
and fatal traps cannot return progress. The private batch ABI changed, so batch
guests need rebuilding with the matching host. Historical performance evidence
above describes the earlier artifacts, not new timings for this failure record.
See the [recovery contract and cost explanation](plugin-host-api-design.md).
The [recovery validation](benchmarks/wasm-batch-recovery-2026-10-21/README.md)
passed 82 Windows runtime tests, 87 physical ARM64 Android release runtime
tests including native/Pulley guest recovery, and 3,585 frontend/SDK tests.
Artifact hashes, raw logs and tablet power/thermal records are retained there.

## Shipped Rust ports, 2026-10-21

Templates and Typst now select Rust components from `plugin-sdk/bundled/`,
with a committed lockfile and pinned Rust 1.97.1 toolchain. Templates uses
scalar host dates, preserving local calendar/locale semantics and the measured
interpreter advantage. Typst preserves the declared-tool protocol, PDF bytes,
diagnostics and source-only fallback. LanguageTool remains manifest-only.
Manifests, permission requests, contribution IDs and effect shapes are unchanged.

Only installable assets and Rust components remain under the embedded
`plugins/` tree. Installable TypeScript examples with distinct IDs are under
`plugin-sdk/examples/`; they retain their per-component QuickJS runtime.
Legacy Luau sources and host annotations moved there as regression fixtures.
The Luau adapter and manifest-v1 support remain available until M5 passes.

Portable Rust Templates and Typst components are 121,114 and 75,297 bytes.
These are component sizes, not matching whole-app package measurements.
The WIT contract is language agnostic, but guests must supply compatible
component bindings and the JSON/effect protocol. Core Wasm, WASI commands
and browser/Node-dependent modules cannot be installed unchanged.
`ts-rust` still emits JavaScript; it does not replace QuickJS in this SDK.
See the [authoring/examples guide](../plugin-sdk/examples/README.md).

Windows workspace tests passed, including 1,038 app tests and 83 runtime tests;
the frontend/SDK suite passed 3,590 tests. The same bundled behavior assertions
cover both shipped Rust and TypeScript examples, including native PDF output
and diagnostic grouping. CI checks committed components, rebuilds the Rust
guests and runs the same behavior assertions against the rebuilt artifacts,
retaining their hashes. Cross-host byte identity is not established: the first
Linux rebuild differed from Windows after source-path normalization. That
strict comparison failed and remains recorded; it is not a functional pass.
Node-only CI also builds the TypeScript examples.

The [shipped Rust validation](benchmarks/wasm-rust-bundled-2026-10-21/README.md)
records 88 physical Android release runtime tests and eight native/Pulley,
portable/AOT probe runs with 100 samples per workload, matching outputs and
zero overruns. AOT Templates render/menu p95 totals were 0.054/2.684 ms native
and 0.288/51.267 ms Pulley on the tablet. The completed macOS/Windows/Linux
portable runtime CI jobs passed the new Rust selection with 500-note menu
Pulley p95 totals 27.057/30.399/22.679 ms. First-party guest linear memory is
lower for render/source-only calls, but the Rust menu uses 2 MiB versus the
TypeScript example's 1.75 MiB. Do not generalize a smaller component into
universally smaller heap usage.

The first workflow failed linting of archived console snippets and cross-host
byte comparison. Those failures and the passing platform reports are retained;
the replacement workflow is tracked separately. Whole-app startup, matching
APK/AAB/installer/macOS bundle sizes, longer memory retention and broader device
conditions still need evidence for this revision. No new installed-app UI
checks are claimed here. Earlier measurements retain their original hashes.
The third CI run also hit `Budget` in the instrumented Linux interpreter
conformance test. The coverage launcher now uses the same serial test policy
as functional CI, keeping all limits and tests; that rerun remains pending.
M5/M6 remain open; retain Luau runtime support.

## Release decision

Targets remain p95 initialization below 20 ms, trivial cached call overhead
below 5 ms, a justified default 32 MiB guest cap, and incremental size at most
15 MB uncompressed on desktop or 15 MB compressed on Android. Cold compilation
is reported separately. Runaway plugins must stop without freezing the UI or
blocking unrelated plugins. Cache capacity, no retained guest instances and
portable SDK semantics must hold on all release platforms.

Do not remove Luau until the physical Android and desktop gates pass and any
budget exceptions have explicit acceptance. M6 then removes `mlua`, the Luau
adapter, legacy manifest branch/types/validation, `.luau` sources, host
annotations and obsolete tests/docs. Keep manifest-only contributions, signing,
permissions and effect validation. Roll back a failed platform gate by retaining
the previous first-party manifests and Luau entries rather than publishing two
permanent executable plugin APIs.
