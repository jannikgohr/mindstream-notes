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

## Validation before the performance PR

The follow-up benchmark compares the original `24e92845` with this branch using
separate empty target directories, the same Rust 1.97.1 toolchain, two Cargo jobs,
locked dependencies and the same development app configuration. Registry sources
were already downloaded for both runs. Build jobs ran sequentially on this shared
machine. A failed attempt that exceeded the `/tmp` quota was discarded before
restarting the comparison on the regular disk.

In addition to cold and unchanged builds, the probes change and restore an app
Rust file and a plugin-runtime Rust file, then verify reuse on the next build.
Source invalidation is useful here: an app edit should not compile plugin
libraries, and a runtime edit should compile its development copy once.

### CI evidence to collect

The `Build performance` workflow runs on PRs that change the build setup or plugin
runtime. It builds the development backend, repeats the exact configuration, and
checks Cargo's JSON artifact stream. An unchanged rebuild fails the job if any
artifact is not fresh. This checks actual compilation reuse without a noisy
elapsed-time threshold. The workflow needs no frontend, guest compiler, display,
Node dependencies or user profile. Its toolchain is pinned to match the local
comparison. A manual run with `cold` enabled skips the Rust cache.

The workflow attaches `development-build-timings`, including initial/repeat elapsed
times, the repeat JSON stream, compiler version, Cargo HTML reports and build-script
phase timings. Its summary includes executable size and reused artifact counts.

The existing native test matrix now attaches `native-test-timings-Linux`,
`native-test-timings-Windows` and `native-test-timings-macOS`. The packaged E2E build
attaches `app-e2e-build-timings`. `build-timings.json` separates bundled plugin
precompilation from Tauri context generation. The Cargo report still covers the
full native build, including compiler dependencies and linking.

Before merging, inspect these reports and run the packaged app suites. Those
suites validate production asset loading after moving context generation into the
build script, bundled plugin loading and the existing execution deadlines. Keep
production release settings while collecting this first CI comparison. An E2E
profile with cheaper linking, Android's repeated app builds and release cache
consistency can then be separate measured changes.

The standalone E2E TypeScript check currently reports missing declarations for
`picomatch` and `lint-ci-filters.mjs` in `spec-discovery.test.ts`. The same two
errors were reproduced on the original commit with the same installed Node
dependencies; they are not introduced by the timing flag in the build helper.

### Comparable local results

The original commit took 355.85 seconds for an empty-target native build. The
branch with reduced dependency debug information took 298.84 seconds. Adding
Linux split debug information took 295.35 seconds. These are sequential single
runs on a shared machine, not repeated statistical estimates. Both branch
variants had empty target directories; neither reused compiled baseline crates.

| Rust backend case                 | Original commit | This branch on Linux |       Observed reduction |
| --------------------------------- | --------------: | -------------------: | -----------------------: |
| Cold build                        |         355.85s |              295.35s |                    17.0% |
| App function code edit            |          18.81s |               16.38s |                    12.9% |
| Plugin-runtime function code edit |          16.12s |               11.07s |                    31.3% |
| Unchanged build after a code edit |           0.46s |           0.45–0.46s | No compilation in either |
| Development executable            |       764.3 MiB |            266.4 MiB |            65.1% smaller |
| Development static library        |      2026.4 MiB |           1285.6 MiB |            36.6% smaller |

The code-edit probes insert a `black_box` call inside an existing function,
compile without running the app, and restore the original source. A separate
comment-only invalidation probe measured 13.62s versus 9.44s for app edits and
15.03s versus 11.72s for runtime edits. The table uses executable-code changes
rather than the cheaper comment-only case. Restoring each code edit also caused
the expected compilation, and every following unchanged build reused artifacts.
App edits reused the runtime dependencies. Runtime edits compiled the runtime
and app, with the branch omitting the host AOT copy.

The first unchanged baseline invocation compiled the app again for 12.59s.
The corresponding branch build compiled nothing. Its first repeat still took
3.80s for Cargo and filesystem work, then settled to about 0.45s. This is why the
CI guard checks `fresh` artifacts rather than a fixed time limit. The earlier
30.09-second extra rebuild was a separate observation on the same machine;
it is not mixed into this comparison.

The development profile now keeps limited debug information for non-workspace
packages. Workspace code retains full debug information, and optimization levels,
debug assertions and the Pulley optimization are unchanged. Production release
profiles are unchanged.

On native Linux, the development launcher defaults to unpacked split debug
information. Debugging data is retained in `.dwo` files instead of copying all
of it into the executable and archives. Keep those files for debugging. GDB
successfully resolved source locations and the `conn` and `note_id` local
parameter symbols in the app function after the change, without starting the app.
The smaller executable size does not mean all debugging data disappeared from
the target directory, and is not a claim about runtime RAM use.

Explicit targets and `CARGO_BUILD_TARGET` skip the launcher's Linux default.
An existing `CARGO_PROFILE_DEV_SPLIT_DEBUGINFO` environment setting or an inline
Cargo `profile.dev.split-debuginfo` override also takes precedence. macOS and
Windows keep their existing split-debug behavior. To opt out on Linux:

```sh
CARGO_PROFILE_DEV_SPLIT_DEBUGINFO=off pnpm tauri-dev
```

The local raw results are written to `.output/build-performance/local-results.json`.
Cold build reports include normal runtime compilation, the app and linking;
frontend/server startup and app execution are excluded.

### Final checks

The full native workspace test run under Xvfb and a private D-Bus session passed
1,200 tests, with 6 existing ignored tests. It used the normal default features,
so the host compiler still compiled successfully where enabled. The optimized
development build and its exact unchanged JSON repeat also passed; the repeat
reused all 755 reported artifacts and rebuilt none. GDB resolved app parameter
symbols with split debug information, and the real Tauri CLI forwarded the
expected Cargo flags and environment.

The script checks, YAML parsing, targeted ESLint, Rust formatting and Prettier
checks passed. The standalone E2E typecheck remains at the two original missing
declaration errors described above. Cross-platform native tests and packaged
app suites remain CI checks for the PR. Benchmark comparison targets were
removed after retaining reports; the optimized artifacts remain in this
worktree's normal `src-tauri/target` for subsequent local builds.

## Further CI rounds

The next measured change gives only the packaged E2E build an optimized release
configuration with LTO off, 16 code generation units and optimization level 2.
It still builds through `tauri build` in release mode, with production assets,
release assertions, unwinding and bundled plugin AOT. Shipped release commands
continue to use the checked-in size-focused profile. Set
`MINDSTREAM_E2E_PRODUCTION_PROFILE=1` to compare against that profile locally.
Explicit caller Cargo profile settings remain available.

The timing artifact now includes `rust-profile.json`, recording the three actual
release overrides. The E2E cache key includes the helper recipe, because those
child-process environment settings are not visible when the cache action runs.
The first run populates dependencies for this configuration; a subsequent run
is needed to measure the steady-state application compile/link cost.

### Round 1: E2E compiler settings

All 22 checks passed on `b2b1e371`, including all three packaged app suites.
The app library and binary compile/link units totaled 83.71s instead of the
baseline's 338.14s. The first build command took 558s, including 475.15s of Rust
work, because it compiled dependencies for the new profile rather than reusing
the previous LTO configuration. A warm-cache result is still required.
The native Windows test build script for fixtures took 93.63s in this run.

### Round 2: guest fixture reuse

Rust guest builds retain Cargo's source, flag and toolchain validation. Their
existing target directories now have a dedicated CI cache. Its keys include job,
OS, architecture, Rust version, Node version, sources and lockfiles. Separate job
keys avoid an incomplete conformance-only E2E cache winning a race against jobs
that build the full fixture set. This cache is separate from native targets, so
it does not invalidate the newly populated E2E compiler cache.

TypeScript fixture components can be reused across Cargo output directories
when source, WIT, SDK, builder recipe, lockfile, Node version and platform match.
The cache verifies the output digest and replaces entries atomically. Missing,
corrupt or inaccessible caches rebuild normally. Only one entry per fixture is
retained. Set `MINDSTREAM_PLUGIN_FIXTURE_CACHE=0` to force fresh component builds.
Source-directory watches also let Cargo notice added imports.

A local first/repeat fixture build produced byte-identical bytes for all seven
components. The three TypeScript component steps totaled about 1.02s initially
and 0.11s on cache hits. Bundling still runs, and its exact JavaScript output is
also part of the cache key so compiler configuration changes invalidate it. Rust validation continued on every invocation.
The plugin runtime's 94 tests passed with these components. Unit checks cover
source/WIT/recipe/lock invalidation, added files, corrupt output and cache I/O
failure. Each output directory records per-fixture times and cache-hit state in
`fixture-build-timings.json`, retained by the native test and runtime jobs.

The cache preserves a built component's bytes; it does not assume independent
fresh QuickJS snapshots are byte-reproducible. Direct SDK builds and the
prebundled cache path expose identical component interfaces, and runtime tests
validate execution. The packed SDK authoring check passed without Rust installed.

All 22 checks passed on `927db0b7`, including all three packaged app suites.
The Windows fixture build script took 31.80s with restored guests and TypeScript
cache hits. The macOS fixture build script took 12.45s. The earlier cache
population run took 162.96s for the Windows guest steps alone. These measurements
come from different hosted runners, so the exact reduction needs repeat evidence.
The development workflow's unchanged build took 0.62s and reused all artifacts.

### Round 3: E2E cache recipe correction

The E2E command still rebuilt dependencies despite an exact native cache hit.
The action ignores its `key` input when `shared-key` is set. The profile hash
therefore never reached the actual cache key, and every run restored an immutable
cache from the previous release profile. The recipe hash now goes directly into
`shared-key`. This first corrected run will populate the separate cache; a
subsequent run must verify reuse before claiming a warm packaged-build speedup.
Compiler settings and guest cache recipes stay unchanged.

All 22 checks passed on `203bb29b`. The E2E job used the corrected cache key,
compiled its dependencies on a cache miss and uploaded the new cache. The
development repeat reused all artifacts in 0.46s. All three TypeScript fixture
components were cache hits on both Windows and macOS.

### Round 4: warm-cache confirmation

The final confirmation changes reporting only. Native and packaged build jobs
now display retained per-fixture durations and cache hits in the Actions summary.
The reports identify their output directories and can describe earlier builds
if Cargo reuses those directories. Compiler inputs and cache recipes stay the
same so the packaged build can restore the cache populated in round 3. Compare
its Cargo timing report and actual restored key before interpreting elapsed time.
