# Windows interpreter deadline diagnosis and plugin migration

The raw logs, data and scripts this report names are not in the repository.
They are in `mindstream-wasm-benchmark-evidence-f2f27a89.tar.gz`, under
`mindstream-wasm-benchmark-evidence/docs/benchmarks/wasm-windows-deadline-2026-10-21/`. The archive's
SHA-256 is `f371ed5c864ee308336e167b23ac29ffd6ceb8e9bf43ecc52384e75c72cb85f5`.

The checked-in debug profile now optimizes only `pulley-interpreter` at level 2. App/host debug assertions, the default 1,000 ms guest deadline, memory caps,
test selection and the release profile stay unchanged. Cargo's
[test profile inherits dev and supports dependency overrides](https://doc.rust-lang.org/cargo/reference/profiles.html).

Pulley is the host VM that executes guest instructions. Building that VM with
no optimization made a normal TypeScript/QuickJS conformance call approach
the deadline even on the local Ryzen 7800X3D. This is host execution cost,
distinct from compiling the plugin's Wasm component or the guest language's
own optimization settings. Shipped Templates and Typst already use Rust; the
TypeScript conformance guest remains required SDK coverage.

## Local comparison

The matched commands use identical source, conformance components and inputs.
Only the VM dependency's optimization setting changes:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --locked -p mindstream-plugin-runtime --config 'profile.dev.package.pulley-interpreter.opt-level=0' the_interpreter_gives_the_same_answers_as_native_code -- --nocapture --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml --locked -p mindstream-plugin-runtime the_interpreter_gives_the_same_answers_as_native_code -- --nocapture --test-threads=1
```

| Guest through Pulley           | VM unoptimized, call | VM optimized, call |
| ------------------------------ | -------------------: | -----------------: |
| Rust conformance               |           88.6872 ms |          3.6466 ms |
| TypeScript/QuickJS conformance |          713.0345 ms |         13.8761 ms |

These are single diagnostic calls per guest/configuration, not p95 release
benchmarks. Preparation takes about 0.3–2 seconds in these debug processes
and precedes the guest deadline. The table excludes preparation and instance
initialization. TypeScript instance initialization was 8.0061/3.6333 ms.
Guest linear memory stayed 1,179,648 bytes for Rust and 1,572,864 for
TypeScript in both configurations. Whole-app memory and startup were not
measured here.

`local/unoptimized-override.log.gz` and `local/optimized-final.log.gz` are the
matched final-source runs. `environment.json` records Windows/toolchain/power
details; host thermal and cooling conditions were unobserved. The
`test-executables.json` hashes describe the final unoptimized, optimized and
workspace test executables. Earlier exploratory logs lack their own binary
hash snapshots and are not the source of the comparison table.

## Validation and CI

Local workspace validation passed 1,038 app tests and 83 runtime tests,
including interpreter parity, 100 ms runaway stopping, cancellation, memory
limits and permission checks. Integration suites passed 1, 8 and 5 tests;
six app tests and one integration test remained explicitly ignored. Rustfmt
and all-target workspace clippy passed with warnings denied. Svelte checking
reported zero errors/warnings, and all 3,608 frontend/SDK tests passed.

Two earlier inventory-test setup failures are retained in the local logs.
The first used the Wasm-only SDK preflight for declarative LanguageTool; the
second imported UI validation into a Node-only test. The final inventory test
checks every shipped manifest's version/runtime and absence of Luau sources.
Existing app validation tests cover LanguageTool's declarative contract, and
SDK preflight plus guest behavior tests cover executable packages.

[Workflow 39637357134](https://github.com/jannikgohr/mindstream-notes/actions/runs/39637357134)
tests source `d16d432c66e087cce87c6d2bd7c51e56aaf38347`. The optional manual
diagnostic records the unoptimized Windows control separately, then requires
five optimized parity/runaway runs to pass. The normal three-platform
workspace and release probe jobs still run. An unoptimized diagnostic failure
would be recorded as control evidence rather than a passing release gate.

The isolated Windows CI control passed this time. Its TypeScript call took
942.4596 ms, with 11.4009 ms instance initialization. That measured subtotal
is 953.8605 ms against the 1,000 ms deadline, before other small setup costs.
All five optimized repetitions passed; the same subtotal was
24.36–26.49 ms. Rust's subtotal fell from 115.97 ms to
5.75–6.02 ms. Memory was unchanged. The original workflow's failure did
not identify its guest or phase, so these measurements must not be described
as a reproduction of that specific timeout. They identify a large avoidable
interpreter cost and show why the old configuration had little margin.

`ci/diagnostic-summary.json` records the phase measurements; raw logs and exit
codes from the uploaded diagnostic artifact are retained under
`ci/diagnostic/`. Preparation remains outside the execution budget and is
reported separately. These five calls are not 100-sample release benchmarks.
All three workspace jobs passed, including all 83 Windows runtime tests, as
did all three release probe jobs, rebuilt guest validation, all three JS jobs,
Linux coverage, browser tests and both collaboration app suites. The overall
workflow failed because two packaged single-client plugin tests still
expected the template action before a source was configured. Their failure
log is retained as `ci/119356956460.log.gz`.

The fixture now clears/configures the real folder picker, waits for its
setting to reach SQLite, and tests discovery and disable/restart behavior
with the seeded Personal/Ideas source. Its IPC test now correctly names the
shipped guest as Rust. These are test setup changes; product visibility rules
and plugin code are unchanged.
[Follow-up 39641550308](https://github.com/jannikgohr/mindstream-notes/actions/runs/39641550308)
tested `e01a586e4a60e8d6e997e8cf28180c87a5302831` and exposed two test
problems. The folder-picker helper clicked its label span rather than the
button; it now targets `button[aria-label="Template folder"]`. A Windows
editor lifecycle test also relied on an arbitrary 10 ms sleep. That test now
advances fake timers through the actual initial/debounce timers. Its 31-test
suite passed locally. Neither fix changes production behavior or budgets.
The superseded run contains failed and cancelled jobs, recorded as such in
`ci/39641550308/run.json`; cancelled macOS jobs are not passing evidence.

The actual Windows release E2E app then passed all four plugin checks:
conditional action discovery, Rust component execution through Tauri IPC,
settings listing, and disable/restart persistence. Raw build, failed fixture
and passing rerun logs are retained in `local/`. `native-app-artifact.json`
records the executable hash; `native-app-environment.json` records the driver
and WebView versions. The driver warned that WebView 155 was untested; the
checks still passed. This E2E app includes the real frontend and test data-dir
instrumentation. It is not a production startup, memory or package baseline.

[Final workflow 39643916426](https://github.com/jannikgohr/mindstream-notes/actions/runs/39643916426)
passed every job at `a8dd605e33b9f495a0fd720d19b7d83985cfdeef`: all three
desktop Rust workspaces, JS suites and portable release probes, rebuilt
shipped guests, Linux coverage, browser E2E, and all three packaged-app
suites. Its raw logs, final job statuses and release reports are under
`ci/39643916426/`. The 12 release reports contain 42 workload cases,
including prototype comparison probes: 100 warm samples each, the default
1,000 ms budget and zero overruns (4,200 samples total). Cold preparation is
reported separately. Windows/macOS process memory fields are unavailable,
so these reports do not establish whole-app memory or retention gates.

The collector preserves original release-report ZIPs and verifies their
SHA-256 against GitHub artifact digests. `SHA256SUMS` covers every archived
file except itself. Compressed logs/reports preserve their original bytes;
JSON metadata and summaries use LF line endings. `local/initial-build.log.gz`
contains an exploratory command that selected zero tests and is not counted
as validation.

## Shipped plugins

Every package under `plugins/` now uses manifest version 2:

- Templates uses the already ported Rust/Wasm component.
- Typst uses the already ported Rust/Wasm component, with source editing when
  the optional native tools are absent.
- LanguageTool now uses a v2 manifest-only package. Its host-owned checker and
  native-service contributions need no guest executable. Its ID, settings,
  permissions and disabled-by-default behavior stay unchanged.

Installable TypeScript examples remain outside the shipped plugin tree.
Legacy Luau fixtures and the adapter remain for compatibility and regression
testing until every required M5 release gate passes. This work does not
provide fresh physical Android app UI, matched whole-app startup/package-size
or longer memory-retention evidence. Those gates remain open.
