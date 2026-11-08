# Build time analysis

Measured from successful GitHub Actions runs, with configuration checked against workspace commit `24e928454ffee0d5af9bf24fb21c900787c2ed8c`. The CI observations below predate the optimizations on this branch. Development build measurements and changes are recorded separately below.

Sources:

- [Test, November 8, 10:02 UTC](https://github.com/jannikgohr/mindstream-notes/actions/runs/42469718611)
- [Earlier Test run, November 8, 04:33 UTC](https://github.com/jannikgohr/mindstream-notes/actions/runs/42447302419)
- [Browser SQLite, November 8](https://github.com/jannikgohr/mindstream-notes/actions/runs/42469718569)
- [Latest successful release, October 25](https://github.com/jannikgohr/mindstream-notes/actions/runs/40191802474)

These runs are different revisions from the workspace and from each other. Treat release and test figures as separate observations, not a controlled comparison.

## Where time goes

| Build step              | Total step | Rust, Cargo-reported | Frontend, Vite-reported | Remaining time |
| ----------------------- | ---------: | -------------------: | ----------------------: | -------------: |
| Tauri E2E app build     |      8m12s |                6m55s |             about 1m12s |       about 5s |
| macOS universal release |     31m32s |               28m53s |             about 1m48s |      about 51s |
| Linux release           |     15m25s |               11m11s |             about 1m16s |    about 2m58s |
| Android APK + AAB       |     33m34s |         about 28m48s |             about 1m13s |    about 3m33s |

Remaining time includes command startup, packaging, signing, downloads and, for desktop releases, uploads. These are rounded log-derived timings. Cargo totals include build scripts and linking. They do not isolate those phases.

## The normal CI critical path

The Test workflow took about 15m12s from creation to its final CI check. The path that determined completion was change detection, Tauri E2E build, then the single app suite.

- Tauri E2E build job: 9m45s, including setup and artifact collection.
- Its frontend/Rust build command: 8m12s. Rust accounts for about 84% of that command.
- App suite job after the build: 5m08s, including 4m14s running the suite.
- The earlier successful build job took 9m25s, so the long build is repeatable across these two observations.

The E2E Rust cache was an exact hit, restoring 876 MB. Cargo then rebuilt workspace/path crates including plugin-runtime, storage-core, etebase and the app. There was no broad external dependency rebuild in that Cargo invocation. A cache hit does not remove the cost of compiling the application.

Other jobs run in parallel. Coverage took 11m25s and Windows Cargo tests took 10m12s, but neither determined completion in this run. The Windows Cargo test step took 8m28s; Cargo compilation was 4m37s, leaving roughly 3m51s for tests and surrounding work. Calling all of that build time would overstate compilation cost.

## Why Rust is the first target

`src-tauri/Cargo.toml` configures release builds with `codegen-units = 1`, `lto = true` and `opt-level = "s"`. The E2E build uses this same release profile. That is a strong candidate for the long compilation/link tail, but the logs cannot quantify its individual contribution.

The app also has plugin-runtime as both a normal dependency and an `aot-build` build dependency. The latter enables Wasmtime's `all-arch` feature. Cold release logs show Wasmtime and Cranelift compilation. `src-tauri/build.rs` precompiles bundled plugins on release builds; that work is inside the Cargo totals and has no separate timer. Changing localization JSON or bundled plugins reruns the app build script and its precompile function. There is no per-plugin reuse check in that function.

Next experiment: a separate E2E profile using ThinLTO or no LTO and more codegen units, keeping production release settings intact. Run the packaged suite and plugin deadline checks before adopting it. Preserve the existing Pulley interpreter optimization. A timing artifact from `cargo build --timings` plus timers around plugin precompilation would distinguish build-script cost from code generation and linking.

## Release-specific multipliers

All three inspected release Rust caches missed. The jobs use floating stable Rust; the Android log shows an update from 1.99.0 to 1.99.1, and the cache key includes the compiler version. This is a plausible contributor to misses, not proof that it was the only cause. Pinning and deliberately updating the compiler would make cache reuse more predictable.

macOS builds ARM64 and x86_64 sequentially. Cargo reported 15m19s and 13m34s. Together they account for about 92% of the combined build/sign/upload step. Separate architecture jobs could reduce elapsed time if universal packaging remains a final job, though total compute would remain similar.

Android targets four ABIs and produces both APK and AAB. The log has eight nontrivial Cargo passes totaling about 28m48s, plus one 0.49s no-op pass. Several later passes recompile just the app for approximately two minutes each. Investigate repeated app invalidation between packaging passes before reducing ABI coverage. The current logs do not show the fingerprint reason, so they do not prove these passes are redundant.

## Frontend cost

On November 8, standalone `pnpm build` steps took 1m13s on Linux, 1m45s on Windows and 2m53s on macOS. Linux Vite reported 6,312 modules transformed in the server pass and 10,058 in the client pass. The client time is nested inside the overall SvelteKit build time; do not add the two printed durations.

The dependency graph includes Excalidraw/React, Milkdown, Mermaid, PDF libraries, image-js and two icon packages imported through package entry points. Lazy imports still require production bundling. Package-level profiling is needed before blaming any one library. Vite's optimizeDeps list affects development dependency prebundling and is not the first production-build optimization to try.

The Browser SQLite run spent only 10.47s compiling release WASM, and its second invocation was a 0.10s no-op. That workflow's test steps also start frontend builds, so their durations are not pure WASM time.

Priorities: measure a faster E2E Rust profile, explain Android's repeat app builds, improve release cache consistency, then profile frontend transforms. Expected savings need an A/B build; the existing logs establish where to measure, not a guaranteed speedup.

## Development and repeated local builds

`pnpm tauri-dev` starts Vite through `pnpm dev:native`, then runs Cargo with
`dev-environment` and the development app configuration. It does not run
`pnpm plugins:build`, `plugin-sdk/fixtures.mjs`, or the browser WASM build.
The shipped `plugins/templates/plugin.wasm` and `plugins/typst/plugin.wasm`
are already committed.

There are three separate kinds of plugin work:

- `tauri-plugin-*` crates and `mindstream-plugin-runtime` are native Rust
  dependencies. They need compilation when their features, inputs or compiler
  change. They are not the guest plugin source builds.
- `pnpm plugins:build` explicitly compiles the shipped Rust guests. Its script
  builds once without path remapping, discovers source paths in the binaries,
  then builds again with remapping flags. Repeating that command alternates the
  flags again. This is a separate optimization candidate; `tauri-dev` never
  invokes it.
- Release builds precompile the committed guests into native Wasmtime artifacts.
  The app build script already skips that function in a debug build. Before this
  branch, Cargo still compiled its unconditional host dependency, including
  Wasmtime's `all-arch` compiler, even when that function would not run.

The development change makes the host compiler an optional build dependency
behind the default `bundled-aot` feature. The development launcher disables
Cargo defaults and still explicitly enables `dev-environment`. Release commands
keep the defaults and AOT generation. The normal runtime remains available in
both configurations, and the existing Pulley interpreter optimization remains.
Explicit `--features bundled-aot` can restore the compiler for a development
invocation that needs it.

The `--no-default-features` argument must follow Tauri's first `--`, because it
is a Cargo runner argument. Tauri otherwise re-enables the manifest defaults
itself. This behavior was checked against the installed CLI and its
[development argument handling](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.0/crates/tauri-cli/src/interface/rust.rs).

A fresh native build, an unchanged second build, and switching command options
must be distinguished. Changing `TAURI_CONFIG` reruns the app build script.
Changing Cargo features, build/check/test mode, Rust flags, target or toolchain
can select different dependency artifacts. A worktree also starts with its own
`src-tauri/target` unless a target directory is explicitly shared.

Runtime preparation after the app has started is another operation. The runtime
has a persistent Wasmtime cache under the app data root's `plugin-cache/wasm`.
It reuses compatible artifacts and compiles when none can be loaded. A new
engine compatibility hash or a new app data root causes a miss. The development
app has its own identifier and data root. Startup preparation is not Cargo
rebuilding the shipped guest sources.

### Local reproduction

The baseline used Rust 1.97.1 on Linux, six logical CPUs, with the user's
existing Cargo setting of two build jobs. Other work was running on the machine.
The target directory was initially empty. These figures measure the Rust
backend, not Vite startup, app startup or runtime plugin preparation.

| Baseline invocation                                      | Cargo duration | What rebuilt                    |
| -------------------------------------------------------- | -------------: | ------------------------------- |
| Fresh backend build with `dev-environment`               |          7m09s | Native dependency graph and app |
| Same command, no source edits                            |         30.09s | App only                        |
| Same command again                                       |          1.01s | Nothing                         |
| Development launcher, switching to its app configuration |         19.61s | App only                        |
| Same development launcher again                          |          0.65s | Nothing                         |

Cargo fingerprint logging identified a generated Tauri icon file inside
`OUT_DIR` as newer than the compilation timestamp. `generate_context!` creates
that file while compiling the app library. Cargo then recompiles the app on the
next invocation. The icon is written only when its contents change, so this
settles after the extra build; it did not reproduce an endless dependency
rebuild. None of the shipped guest sources or native plugin dependencies were
recompiled during those unchanged warm invocations.

This branch generates Tauri's context through `tauri_build::CodegenContext` in
`build.rs` and includes it with `tauri::tauri_build_context!`. Icon and context
outputs then exist before app compilation. This also registers the icon inputs
with the build script.

The cold Cargo timing report shows two Cranelift code-generation units, one
with `all-arch` at 34.73 seconds and one without it at 32.60 seconds. Wasmtime
likewise compiled separately for host and runtime, at 10.16 and 14.96 seconds.
The plugin runtime itself compiled twice, at 3.08 and 6.19 seconds. Unit times
can overlap, so these are not additive wall-clock savings. The new development
feature graph removes the host AOT dependency and has no `all-arch` feature.

Launcher checks used Tauri's real argument parser with a runner that substitutes
`cargo build` for `cargo run`, preserves its Cargo arguments and environment,
and never starts the app. The frontend hook was disabled for this backend
measurement. The development app identifier was still merged normally.

After the changes, the first development backend build completed successfully.
Its 2m46s duration reused existing dependency artifacts and is not a clean
before/after comparison with the 7m09s cold baseline. The next two unchanged
launcher builds took **0.68s** and **0.45s**, with no compilation or fingerprint
invalidation. In particular, the first unchanged invocation after generating
context no longer incurred the baseline's 30.09-second app rebuild.

Verification covers the real Tauri launcher argument parsing, four launcher
regression cases, the development backend build and repeated unchanged builds,
Cargo formatting, and the default/development feature graphs. Release defaults
retain `bundled-aot` and Wasmtime's `all-arch`. Signed release packaging and a
new cold-build speedup measurement remain separate follow-up checks.

For a future local rebuild investigation, keep the command and environment
unchanged and enable Cargo's reason logging:

```sh
CARGO_LOG=cargo::core::compiler::fingerprint=info pnpm tauri-dev
```

The `stale` and `dirty` entries distinguish a changed generated file, a changed
source file, an environment change and a dependency feature change. The first
restart after this branch changes the feature graph will rebuild affected
native dependencies once. Repeated unchanged invocations should then reuse
them.

### Frontend development startup

A separate two-start probe ran `dev:native` on an unused port, fetched `/` once
after Vite reported ready, and stopped the server. No WebView or real profile
was opened. The first run had a fresh Vite dependency cache; the second reused it.

| Frontend measurement                                       | Fresh cache | Reused cache |
| ---------------------------------------------------------- | ----------: | -----------: |
| Vite's reported ready time                                 |       2.31s |        1.55s |
| First HTML request after ready                             |      12.95s |        1.19s |
| Dependency metadata available, measured from process start |      18.22s |        3.00s |

Vite prebundled 110 dependencies. This work continues after its ready message,
so that message understates the first-start cost. The metadata timestamp
confirmed cache reuse on the second run. The HTML probe does not measure the
app's interactive load or lazy editor imports. The first frontend probe briefly
overlapped the end of a native verification build, so these are diagnostic
observations rather than a controlled frontend benchmark. There is no evidence
here that frontend dependency optimization repeats on every unchanged restart.

The default native feature configuration also built successfully after the
changes and its unchanged repeat took 2.26s with no compilation. All 29 script
checks in `pnpm lint:ci` passed, including the four launcher regression tests.
