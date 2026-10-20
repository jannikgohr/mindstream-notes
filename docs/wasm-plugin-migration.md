# Wasm plugin migration gates

The migration has a working Wasmtime runner, TypeScript SDK and first-party
Wasm components. M5 still needs platform measurements and physical Android
ARM64 execution. M6 is blocked by that gate. Luau, its bindings and the old
bundled sources remain available for regression comparisons until then.

## Milestone status

| Milestone                  | Evidence                                                                                                             | Remaining work                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| M0, inventory and baseline | Host/API inventory below; Linux Luau measurements                                                                    | Baseline startup and whole-process memory on representative desktop and Android hardware            |
| M1, shared host services   | Runtime-neutral crate; existing Luau host tests                                                                      | None identified                                                                                     |
| M2, Wasmtime integration   | Verified entry bytes, compile caches, fresh stores, limits, cancellation, permission tests                           | Cross-platform release gate below                                                                   |
| M3, TypeScript SDK         | Packed tarball creates, installs, typechecks, builds, checks and tests a project without Cargo or rustc              | Run the added desktop CI matrix                                                                     |
| M4, bundled ports          | Templates and Typst use manifest v2/Wasm; Node tests and app-host tests; template output compared with retained Luau | No local functional gap found; platform gates remain under M5                                       |
| M5, parity and performance | Portable native/interpreter probe and desktop CI artifacts                                                           | macOS/Windows results, physical Android ARM64, package size, app lifecycle and startup measurements |
| M6, retire Luau            | Intentionally pending                                                                                                | All M5 gates must pass first                                                                        |

The npm SDK stays private during migration. It can be packed and installed
locally. This is not an SDK v1 compatibility promise. The ABI is
`mindstream:plugin@0.1.0`; manifest v2 intentionally rejects Luau. Both manifest
versions still accept manifest-only packages.

## Execution inventory

| Path                         | Entry points or responsibilities                                                                         | Verification                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Templates                    | `newFromTemplate`, `renderTemplate`; nested folder/tag selection; date math, variables, filters, UUIDs   | `plugin-sdk/bundled/bundled.test.ts`; app-host template regression tests                      |
| Typst                        | `renderDocument`, `exportDocument`; stdin to declared `typst`, PDF bytes and stderr diagnostics          | Built-component tests for success/failure/timeout, source-only fallback through the app host  |
| LanguageTool                 | Manifest-only text-checker and native-service contributions                                              | Existing manifest, diagnostics, source-editor and E2E tests                                   |
| `plugins::run_plugin_script` | Dispatch Luau/Wasm after package approval; verified component bytes; backend context merge               | App plugin tests including checksum changes, permissions and v2 entry discovery               |
| Luau adapter                 | Fresh VM, plugin-scoped module loading and old entry contract                                            | Retained `src-tauri/src/plugins/luau.rs` tests                                                |
| Wasm adapter                 | Shared engine, memory/disk cache, bounded concurrency, fresh stores, JSON ABI, epoch interruption        | `src-tauri/plugin-runtime/src/wasm/tests.rs`, both Rust/TypeScript fixtures and Pulley        |
| Host services                | Dates, frontmatter, logging, note metadata, isolated storage, native processes, limits and cancellation  | Runtime crate tests, called by both adapters                                                  |
| Declarative effects          | `none`, `toast`, `createNote`, `createNoteFromNote`, `insertMarkdown`, `openMenu`                        | Frontend effect validation and existing menu/template tests                                   |
| Lifecycle                    | Disable, crash, package update/reapproval and removal cancel active calls; fresh stores after completion | Cancellation registry, native-process and Wasm tests; device lifecycle testing still required |

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
features, target and toolchain. No current app-size delta has been established.
The scratch timing experiment is historical evidence, not a committed baseline
benchmark that CI can reproduce. Repeat representative whole-app measurements
before approving the gate.

The initial standalone toolchain experiment found substantially smaller
QuickJS components than StarlingMonkey, so the SDK uses `componentize-qjs`
with its size-optimized engine. Runtime limits apply to summed guest linear
memory; process RSS/PSS and compiled-cache memory must be measured separately.

## Recorded Linux Wasm measurements

The [JSON report](benchmarks/wasm-plugin-linux-x86_64.json) records the component
hashes, toolchain, host reports, guest linear memory and timing distributions.
These release-mode samples used a development machine with concurrent builds,
so they do not close the representative-hardware gate.

| Case                       | Native call p95 | Pulley call p95 | Guest memory |
| -------------------------- | --------------: | --------------: | -----------: |
| TypeScript echo            |         0.54 ms |         0.81 ms |     1.50 MiB |
| Templates render           |         0.51 ms |         9.29 ms |     1.44 MiB |
| Templates menu, 500 notes  |        37.73 ms |      1214.43 ms |     1.75 MiB |
| Typst source-only fallback |         0.27 ms |         1.13 ms |     1.44 MiB |

The largest p95 instantiation time was 0.31 ms. Cancellation completed in
30 to 35 ms and the requested 100 ms timeout fired in about 102 to 107 ms.
Both guest languages stopped at a 4 MiB memory cap. Cold compilation and disk
cache loads are reported separately in the JSON. Process memory includes
compiled components and compiler state and is separate from guest memory.

## Repeatable checks

From the repository root:

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
100 samples. Timed workloads request the existing five-second host ceiling
so expensive cases can finish and report their cost. This does not change
bundled manifests or the app's one-second default. Dedicated timeout checks
still request 100 ms. Component SHA-256 hashes identify the measured bytes.
Release mode is recorded in the JSON report. Debug timings do not count.

A local Pulley run of the 500-note Templates menu exceeded the app's default
one-second budget. That is an unresolved M5 performance regression on the
interpreter path, even though native execution succeeds. The measured stress
case uses the five-second ceiling to quantify it. Do not mark interpreter
parity passed or remove Luau on the strength of trivial-call timings. Resolve
this workload or explicitly accept a changed budget before M6.

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

The full frontend suite passed 3,579 tests in 300 files with two workers.
After the WIT generator and Node module-scope fix, all 24 SDK/bundled tests
passed again. The Rust workspace passed 1,040 app unit tests, its integration
suites and 75 runtime tests. The final bundled components also passed their
app-host regression checks.

The production web build and Svelte type check passed. Rustfmt, clippy with
warnings denied, ESLint, theme/i18n lint and CI-filter tests passed. The
17 selected browser plugin/source-editor tests passed. The packaged Tauri
plugin suite passed all four tests, including the Wasm export through IPC and
enable/disable persistence across restart. Both the Node-only packed SDK
workflow and a fresh Rust starter build succeeded.

The Android library check stopped at a missing
`aarch64-linux-android-clang`; no device run or Android package measurement
has occurred. No macOS/Windows CI result has been observed from this session.

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
