# Wasm preparation and Rust Templates comparison

The raw logs, data and scripts this report names are not in the repository.
They are in `mindstream-wasm-benchmark-evidence-f2f27a89.tar.gz`, under
`mindstream-wasm-benchmark-evidence/docs/benchmarks/wasm-optimization-2026-10-21/`. The archive's
SHA-256 is `f371ed5c864ee308336e167b23ac29ffd6ceb8e9bf43ecc52384e75c72cb85f5`.

Implementation: `3b070fcf`; probe controls and embedded buffers: `9c211cad`.
Measurements use the physical Samsung SM-T733, Android 14/API 34, ARM64,
from the M5 investigation. See `toolchain.txt` for versions,
device fingerprint and host details. `host-cpu.txt` records the
host processor. Dates in this folder use Europe/Berlin;
the raw run timestamps use UTC.

## Changes under test

Release app builds precompile the bundled components with their target's
baseline CPU settings and the same Wasmtime configuration used at runtime.
The signed binary embeds gzip-compressed artifacts plus their source, code and
engine hashes. First use decompresses the matching artifact into the private
disk cache and loads it through the existing cache. A missing or incompatible
artifact falls back to compiling the portable component. The original `.wasm`
files remain in the package. `MINDSTREAM_BUNDLED_AOT=0` builds the matching
portable control. Debug builds use portable components.

Native artifact loading is unsafe in Wasmtime. Only artifacts from the app's
own build enter this path. A third-party package signature never grants
permission to deserialize native code. Installed plugins still undergo their
existing package checksum, signature, generation and approval checks.

Discovery prepares enabled, approved plugins on a serial background worker.
Approval and enable also schedule preparation. The queue holds at most eight
waiting jobs and deduplicates component/cache pairs. A full queue leaves
preparation to the normal call path. Jobs retain immutable verified bytes and
the package lease, take no database lock and run no guest code. A queued
compilation may finish after disable/removal or vault closure, but cannot
execute a guest or bypass a later call's current approval checks. Synchronous
Cranelift compilation itself is not cancellable.

Builtin metadata is verified once per process because the bytes are embedded
and immutable. Its component digest is reused only for the exact immutable
buffer it identifies. Embedded entries need no heap copy. Filesystem packages
retain full integrity checks on invocation. Every invocation still creates a
fresh store and guest instance.

The [Rust Templates prototype](../../../plugin-sdk/prototypes/templates-rust/README.md)
implements both Templates exports through the same WIT host API. It remains
separate from the shipped TypeScript plugin. Native unit tests compare dates,
offsets, filters, folder cycles, tags and Unicode sorting; release tests also
cover Pulley. Debug parity uses 50 notes because debug interpreter execution
exceeded the unchanged budget. The release measurements use 500 notes.

## Measurement protocol

Each language/backend/compilation combination runs in its own process through
`plugin-sdk/android-runner.mjs`, with 100 warm samples and the default 1,000 ms
budget. A fresh private cache is used per case. Cold preparation is one
observation per case, not a cold percentile. The probe asserts `Bundled` for
precompiled first use, `Compiled` for portable first use, `Memory` for warm
calls and `Disk` after clearing the memory cache. `summarize.py` verifies all
sample counts, budgets, artifact sources and matching outputs before producing
`comparison.json`.

The final reports use static embedded bytes like the app. The first diagnostic
pass retained two owned input buffers in the probe; its complete reports and
conditions remain under `diagnostic-owned-buffers/`.
Do not combine memory numbers from these two methods. `--rehash` provides a
same-build control that recomputes the source digest on every preparation.

Process RSS/PSS includes code, host allocations and compiler state. It differs
from guest linear memory. The peak at the end of a process includes both
rendering and menu measurements. These are standalone runtime measurements,
not whole-app memory. A smaller guest artifact does not imply less linear
memory for every operation.

Before and after each run, raw logs record USB charging, battery level,
battery temperature, battery saver and thermal status. The operator reported
normal temperatures. Ambient temperature, case and external cooling were not
observed. Host builds ran concurrently; they did not run on the tablet.

The initial runtime block ran at about 15-17% charge. App testing resumed
later at 30%, about 28.5 C battery temperature, still USB charging, battery
saver off and thermal status 0. Both normal app builds were measured again
in that resumed block. The earlier low-charge app records remain under
`diagnostic-low-charge-app/`. The screen stays awake during UI measurements.
The screen-off run is invalid for plugin UI actions; another incomplete run
was stopped while checking the UI state. Neither enters the comparisons.
Ready and toast screenshots validate the completed app protocol. Its 30
calls deliberately use an unset source to exercise the export without
creating notes. This is a memory test, not functional note-creation evidence.

## Runtime results

All eight Templates-only reports passed 100 samples for each export at the
default one-second budget, with matching outputs and no interrupted attempts.
`comparison.json` contains the validated summary. The two
initial TS portable runs included echo and Typst cases; they are retained as
`full-native.json` and `full-interpreter.json` for safety coverage. They do not
enter the memory comparison below. Templates-only portable controls were
repeated with the same probe hash after charging to 30%; the other six runs
were at 15-17%. Both blocks were USB charging with saver off and thermal status 0. These sequential observations are not randomized, power-controlled trials.

| Backend and build         | Cold render preparation | Warm render total p95 | Warm 500-note menu total p95 | Process peak RSS after menu |
| ------------------------- | ----------------------: | --------------------: | ---------------------------: | --------------------------: |
| ts-native-portable        |               966.47 ms |              0.602 ms |                     25.47 ms |                   81.50 MiB |
| ts-native-aot             |                58.65 ms |              0.561 ms |                     25.68 ms |                   16.03 MiB |
| rust-native-portable      |               124.03 ms |              0.189 ms |                      3.50 ms |                   17.97 MiB |
| rust-native-aot           |                16.75 ms |              0.161 ms |                      2.70 ms |                    8.63 MiB |
| ts-interpreter-portable   |              1128.91 ms |              4.588 ms |                    807.37 ms |                   78.00 MiB |
| ts-interpreter-aot        |                56.80 ms |              4.506 ms |                    801.26 ms |                   15.94 MiB |
| rust-interpreter-portable |               122.47 ms |              0.655 ms |                     51.44 ms |                   20.02 MiB |
| rust-interpreter-aot      |                 8.58 ms |              0.274 ms |                     51.30 ms |                    8.40 MiB |

AOT changes preparation and compiler memory, not the guest's algorithm.
TypeScript's interpreter menu remains about 801 ms, close to the deadline on
slower or busy hosts. Rust's interpreter menu measured about 51 ms. The Rust
component is 121,628 bytes versus TypeScript's 1,727,495 bytes, about 93% smaller.
Android native compiled gzip artifacts were 146,171 versus 1,706,139 bytes.
These are prototype component comparisons, not a measured app package with
Rust replacing TypeScript.

Guest linear memory was 1.438 MiB for TypeScript render and 1.125 MiB for Rust
render. The 500-note menu used 1.75 MiB for TypeScript and 2 MiB for Rust. Rust
has the smaller process footprint here, but does not use less guest memory
for every export. All stores and instances are fresh per call.

The same-build `--rehash` control measured TypeScript native render cached
preparation p95 of 10.756 ms and total p95 of 11.491 ms. Reusing the verified
immutable digest measured AOT cached preparation p95 below 0.001 ms and total
p95 0.561 ms. This isolates recurring digest work in the probe; app discovery,
package verification and IPC add separate costs. It does not justify skipping
checks on mutable installed packages.

The two native AOT soaks completed 1,000 calls per export with no interrupted
attempts and unchanged one-second budgets. At checkpoints 50 and 1,000, process
PSS was identical for each workload: TypeScript render 9,693 KiB and menu
13,681 KiB; Rust render 3,281 KiB and menu 7,341 KiB. Raw RSS/VmHWM checkpoints
remain in `*-native-soak.json`. These short fixed-fixture observations do not
prove absence of retention across broader workloads or long app sessions.
The physical release runtime test binary passed 78 tests with none ignored.

## Release app measurements and functional checks

The normal frontend portable/AOT pair ran at 30% charge with the same app ID,
settings and measurement procedure. First cleared-app activity draws were
833/375 ms. Five later cold activity draws had medians 211/194 ms. These are
`am start -W TotalTime` observations, not interactive-ready latency or a startup
p95. Compilation/preparation can continue after activity draw.

| Normal Android app process measurement |    Portable |         AOT |
| -------------------------------------- | ----------: | ----------: |
| Initial preparation VmHWM              | 270,972 KiB | 166,976 KiB |
| After initial preparation PSS          | 171,301 KiB | 160,735 KiB |
| After 60 s idle PSS                    | 139,042 KiB | 139,725 KiB |
| After 1 Templates call PSS             | 147,103 KiB | 147,402 KiB |
| After 10 calls PSS                     | 154,964 KiB | 154,929 KiB |
| After 30 calls PSS                     | 159,455 KiB | 159,595 KiB |
| After 20 s recovery idle PSS           | 150,377 KiB | 150,377 KiB |

AOT lowered this run's initial compiler peak while leaving steady app memory
about the same. PSS still rose between calls 10 and 30 and fell after idle;
this does not close the long-retention gate. Dumpsys total RSS includes different
accounting from `/proc` VmHWM. Both raw fields remain in `android-app-*.txt`.
The portable control also includes background preparation, so it moves compiler
work before the first deliberate Templates call.

The devtools release recorded 100 IPC samples per case in
`android-app-ipc.jsonl`. Render p95 was 11.4 ms, plugins
list p95 4.3 ms, and the unset-source menu p95 7.5 ms. First render was 10 ms
in the cleared app and 18.9 ms after restart. Discovery had already prepared
the component, so these are not cold-compilation times. The earlier M5 blocks
measured render p95 58.6 ms for Wasm and 12.3 ms for Luau at different charge
levels. Treat those as context, not an isolated causal app comparison.

The memory test's "Set a template folder or tag in Settings..." toast checks
only the unset-source path. Functional testing separately created two source
fixtures through IPC, selected **Wasm migration templates** through the actual
Settings folder picker, and used **New from template** and its plugin menu.
It created a separate `Daily 2026-10-21` note with date/title substitution and
left the source body unchanged. A second selection created a Typst note with
its plugin-owned kind preserved. Typst was initially disabled, which correctly
showed its disabled-editor message. Enabling Typst through Settings opened the
source editor. Native Android input appended text, which persisted across app
restart; the original source template remained unchanged. The compiler status
reported unavailable. No PDF rendering or native service availability is
claimed. `typst-source-edited-ui.json` includes an early diagnostic query of
`tinymist` as a tool; it is declared as a service, so that diagnostic error is
not an availability result. The corrected asserted result is
`typst-source-after-restart-ui.json`.
Screenshots retain the folder setting, created Daily note and edited Typst note.
The UI helpers pin the measurement date and fixture names; adapt these when
reproducing on another day. `tools/typst-input.ps1` records native input steps.

`android-lifecycle.jsonl` records all 15 passing
assertions using the exact signed fixture retained from M5. Storage containment,
approval gating, effects and recovery passed. Disable settled a runaway after
28 ms; removal after 85 ms. UI frame gaps during the checked calls stayed at
about 17 ms, and an unrelated plugin completed in 4.5 ms. An unattended runaway
stopped at 1,016.5 ms wall time with the default 1,000 ms guest budget.
Background/resume retained the process and terminated at the budget; immediate
cancellation on backgrounding remains unverified. Vault closure restarted the
process and preserved per-vault approval isolation. The original vault and
Templates settings survived. Third-party package installation used IPC because
Android has no package installation UI. The normal AOT release was installed
again afterward with data preserved; the production app was never modified.

## Package sizes

All controls use a normal frontend, release opt-level `s`, LTO and stripping.
The AOT environment switch is the controlled build difference. Android uses
the disposable `wasm_m5` ID; the normal production installation is untouched.
The devtools APK is separate and is used for IPC/lifecycle checks only.
`artifacts.json` records sizes, SHA-256 hashes, ABI contents
and native-library hashes. APK signatures verify against the same certificate.

| Normal release artifact   | Portable control |          AOT | AOT increase |
| ------------------------- | ---------------: | -----------: | -----------: |
| ARM64 APK                 |     51,301,815 B | 54,280,023 B |  2,978,208 B |
| Windows x86_64 executable |     42,666,496 B | 46,014,976 B |  3,348,480 B |

Against the matching normal Luau baselines retained from M5, the total
increases are 13,348,144 bytes for this APK and 14,851,584 bytes for this
Windows executable. Both are below 15,000,000 bytes. Windows has only
148,416 bytes of margin. These are not installer, macOS bundle, AAB or
other-ABI results. No stub frontend baseline enters this comparison.

## CI and failure investigation

[Run 39513934906](https://github.com/jannikgohr/mindstream-notes/actions/runs/39513934906)
at `9c211cad` preserved three failures:

- The Windows and Linux app tests passed, but the existing debug interpreter
  host-contract test timed out while compiler fixtures ran in parallel.
  The same workspace command passed serially locally. CI now runs functional
  debug tests with `--test-threads=1`; explicit runtime concurrency tests still
  create their own threads. The guest deadline stays at 1,000 ms.
- The macOS release TypeScript interpreter menu interrupted 10 attempts.
  Its successful-sample guest p95 was 945.17 ms; that percentile excludes
  interrupted calls. Preparation overhead was below a millisecond. Native
  execution passed. The Rust prototype interpreter menu passed all samples,
  with guest p95 37.69 ms. This identifies guest execution as the dominant
  cost; precompilation cannot fix that part of the workload.

[Run 39515421160](https://github.com/jannikgohr/mindstream-notes/actions/runs/39515421160)
at `8b02e37a` passed the entire workflow: all three Rust workspaces, all three
Node 22 jobs, all three runtime probes, browser tests and the Linux single,
multi and multi-a2 packaged-app suites. The complete status and probe outputs
are retained, together with the earlier failure logs and reports.

| Rerun release interpreter menu, 100 samples | TypeScript guest p95 / max | Rust guest p95 / max | Interrupted calls |
| ------------------------------------------- | -------------------------: | -------------------: | ----------------: |
| macOS ARM64                                 |         605.59 / 649.49 ms |     61.61 / 95.39 ms |                 0 |
| Windows x86_64                              |         584.90 / 593.62 ms |     31.03 / 33.87 ms |                 0 |
| Linux x86_64                                |         504.51 / 505.95 ms |     35.39 / 38.47 ms |                 0 |

The macOS release job runs separately from the debug workspace job. Do not
attribute its faster rerun to serializing the debug tests on another runner.
Runner CPU allocation, thermal state and power were uncontrolled. The earlier
release failure remains unexplained and blocks a claim of budget reliability.
CI measurements do not replace representative desktop app startup or memory
tests. CI uses Rust 1.99.1; the Windows/Android build host uses Rust 1.97.1.

## Evidence verification

`SHA256SUMS` covers every file in this evidence folder except itself. JSON
reports were pretty-printed without changing their values. Raw console,
JSONL, conditions and compressed build logs retain their captured bytes.
Local release executables/APKs are not committed; `artifacts.json` records
their hashes, sizes and native-library contents. `android-run-status.json`
normalizes the two renamed full probes and the later Templates-only controls;
the initial and resumed status files preserve the original run records.

```text
python docs/benchmarks/wasm-optimization-2026-10-21/summarize.py
python docs/benchmarks/wasm-optimization-2026-10-21/tools/verify-evidence.py
```

`android-final-normal-ui.png` confirms the preserved note in the normal AOT
release after removing the devtools variant. USB stay-awake was restored to
its original disabled setting and the temporary DevTools port forward removed.
Final battery was 30%, 30.4 C, USB charging, saver off and thermal status 0.

## Reproduction

Build the prototype with Node 22:

```text
node plugin-sdk/prototypes/templates-rust/build.mjs
```

For manual probe artifact generation, stage the two bundled manifests and
components plus the prototype in three subdirectories. Give the prototype a
build-tool-only manifest with `runtime: "wasm"`, `entry: "plugin.wasm"` and
`id: "templates-rust-prototype"`. Run the compiler for Android and Pulley:

```text
cargo run --manifest-path src-tauri/Cargo.toml --locked --release -p mindstream-plugin-runtime --features aot-build --example plugin-precompile -- aarch64-linux-android STAGED_PLUGINS ABSOLUTE_ANDROID_OUTPUT
cargo run --manifest-path src-tauri/Cargo.toml --locked --release -p mindstream-plugin-runtime --features aot-build --example plugin-precompile -- pulley64 STAGED_PLUGINS ABSOLUTE_PULLEY_OUTPUT
```

Combine the entries of the two generated `precompiled.rs` arrays into one
trusted Rust array file. Set `MINDSTREAM_PROBE_PRECOMPILED` to its absolute
path. Configure the SDK/NDK and linker as in
[the migration procedure](../../wasm-plugin-migration.md), then build:

```text
cargo build --manifest-path src-tauri/Cargo.toml --locked --release --target aarch64-linux-android -p mindstream-plugin-runtime --features probe-precompiled --example plugin-bench
node plugin-sdk/android-runner.mjs src-tauri/target/aarch64-linux-android/release/examples/plugin-bench --templates-only --iterations 100
```

Repeat with each combination of `--rust-templates`, `--interpreter` and
`--precompiled`. Select the physical device with `ANDROID_SERIAL`. An AOT run
fails if its build does not contain a matching trusted artifact. The
`precompiled-*.json` manifests record cross-target compilation success only;
they do not mark those platforms' runtime or app release gates passed.

Luau remains available. M5 and M6 stay open until all required release gates
pass, including representative desktop app measurements, interpreter budget
reliability and broader device/power/retention evidence.
