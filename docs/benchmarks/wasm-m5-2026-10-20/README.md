# M5 test evidence, 2026-10-20

The raw logs, data and scripts this report names are not in the repository.
They are in `mindstream-wasm-benchmark-evidence-f2f27a89.tar.gz`, under
`mindstream-wasm-benchmark-evidence/docs/benchmarks/wasm-m5-2026-10-20/`. The archive's
SHA-256 is `f371ed5c864ee308336e167b23ac29ffd6ceb8e9bf43ecc52384e75c72cb85f5`.

M5 is incomplete. Keep Luau. Physical Android execution and app lifecycle checks
have results, but cached/app-call performance and the macOS interpreter budget
gate have failures. Desktop whole-app startup, process memory and matching
installer sizes have not been measured here.

`SHA256SUMS` covers the evidence files in this directory. Its local
`.gitattributes` disables line-ending conversion so signed fixture bytes and
raw logs survive a Windows checkout unchanged. The historical and final CI
artifact metadata files also retain GitHub's archive digests.
`release-gates.json` records the measured scope and open
gates in machine-readable form. It explicitly forbids Luau removal.

## Revisions and artifacts

- Starting migration revision `2303769c`.
- `9115b342` fixes the Android ARM64 libc trap layout, Android app command
  registration, Windows path separators and Node 22 SDK/CI requirements. The
  release APKs use this revision plus the file-lock fix committed in `436f9b10`.
- `436f9b10` adds Android flock ownership, Windows canonical temp paths,
  packaged lifecycle coverage and reports from probes that exceed their budget.
- Matching Luau baseline `2bdba0b4a34bd1ffd8af65db85de0065fd107fdb`, with
  the exact final compatibility/test-ID patch (`baseline-final.patch`). The
  scratch directory named `main` is this revision, not a newer main branch.
- `artifacts.json` records SHA-256 and byte sizes of all four
  preserved APKs, the matching normal Windows executables and Android test/probe
  executables. Binaries remain in `.output/wasm-m5/artifacts/` or their recorded
  target paths, outside Git.
  Migration APKs also use this disposable app-ID patch (`android-test-package.patch`).
  The committed production application ID is unchanged.
- Earlier `baseline.patch`, `main-android/*.patch` and failed-install/launch
  logs describe intermediate attempts. Use `baseline-final.patch` and the
  `*-locks-arm64.apk` pair for the final normal-app comparison.

The existing production installation rejected the local release signing key.
It was retained. Only `com.jannikgohr.mindstream_notes.main_check` and
`com.jannikgohr.mindstream_notes.wasm_m5` were installed/cleared for testing.
The Java activity namespace stayed `com.jannikgohr.mindstream_notes`.
Both normal builds use a real `pnpm build` frontend, release opt-level `s`, LTO,
one codegen unit and stripping. No stub frontend enters this comparison.
The `*-devtools-arm64.apk` pair additionally enables `tauri/devtools` for app
IPC timing and Android lifecycle automation. They are release builds, but the
extra feature means they are separate from the normal package/memory pair.

## Device, tools and conditions

`android-device-before.txt` records the physical
Samsung SM-T733, serial R52W103DQPB, SM7325 SoC, ARM64, Android 14/API 34 and
fingerprint `samsung/gts7fewifieea/gts7fewifi:14/UP1A.231005.007/T733XXS9DYF1:user/release-keys`.
The device also supports ARMv7 processes; its additional ARMv7 probe is not
evidence from separate ARMv7 hardware.

The Windows build host used Rust 1.97.1, commit `8bab26f4f`, MSVC, NDK r29
`29.0.14206865`, adb 36.0.0-13206524 and Temurin Java 21.0.2+13. Android target
linkers were `aarch64-linux-android26-clang.cmd` and its C++ counterpart under
`C:/Users/janni/AppData/Local/Android/Sdk/ndk/29.0.14206865/toolchains/llvm/prebuilt/windows-x86_64/bin`.
Node 22.21.1 and pnpm 10.34.4 built the plugins/frontend. See
`windows-host.txt` and `toolchain.txt`.

Recorded snapshots show USB charging on, battery saver off, and thermal status 0.
Charge was 5% initially, about 8% for startup/memory comparison and 10% for
the final 100-call app comparison. Recorded battery temperature rose from
29.1 to about 31.7 C. The operator reported "normal temperatures".
Ambient temperature, case and external cooling were not reported. Raw sensors
are in the device log, each app measurement log and
`android-calls-conditions.txt`. App comparisons
ran sequentially, Luau then Wasm, with no simultaneous device build/probe.
They were not randomized or repeated across controlled thermal/power states.

## Runtime and recovery

`android-runtime.json` transcribes the final native,
Pulley and additional ARMv7 reports. The original runner consoles remain in
`android-native-final-console.txt`, `android-interpreter-final-console.txt`
and `android-armv7-default-console.txt`. Each case attempted 100 warm samples
with 1,000 ms guest budget. Native and ARM64 interpreter each completed all
100 samples per case. No manifest/default budget changed. Cold compilation
can take over one second because compilation is outside the guest call budget.
Each report includes component hashes, ordered warm samples, instance/call/
preparation timings, guest memory and process checkpoints. Their hashes match
the committed Rust/TypeScript conformance and bundled components.

The runtime test executable passed 75 tests through `android-runner.mjs`,
including explicit interpreter cases. Its raw log is
`android-runtime-tests-fixed.log.gz`. `android-probe-artifact.txt` identifies
the original ARM64 probe binary. The later ARMv7 binary and hash are recorded
separately. Android file ownership tests passed both exclusive and shared lock
cases in `android-file-lock-tests.txt`.

The first native probe crashed with SIGILL during guest memory refusal. libc
0.2.186 had the wrong Android ARM64 `ucontext_t` padding for Wasmtime traps.
libc 0.2.190 and a compile-time offset assertion repaired this. Initial crash
and stage diagnostics are retained. The release app then exposed Rust std
file locks returning Unsupported on Android. The flock wrapper repaired vault
and package ownership; desktop uses the std implementation. Initial failed
launches and both fixes remain in the evidence.

Guest memory peaked at 1.75 MiB for the menu workload; both guest languages
refused a 4 MiB allocation limit and recovered. This supports bounded guest
memory for these fixtures, not a universal justification for every plugin's
32 MiB default. Runtime process RSS high-water marks were 87,356 KiB native
and 84,108 KiB interpreter. Templates render PSS after warm calls 10 and 100
was 24,618/24,618 KiB native and 23,066/23,078 KiB interpreter. Compiled code,
compiler state and allocator memory are process costs, not guest linear memory.

## Release app and lifecycle

The normal Wasm release UI set Templates' folder to `Templates`, created a
separate `Daily log` note and rendered `Date: 2026-10-20 for Daily log`.
The original template stayed in its folder. Typst was enabled and a Typst note
remained source-editable without its native executable. Screenshots preserve
the folder setting, rendered note, separate root note, Typst source edit and
native-tool check in `screenshots/`.

Android hides third-party plugin installation in its UI. The devtools release
variant staged a signed test folder via `notes_export_write_file`, then invoked
the real install/approval/settings/storage commands through the app bridge.
`android-lifecycle.jsonl` records approval gating,
storage write/read/list/delete and traversal refusal, cancellation, recovery,
WebView frames, another plugin's response and vault approval isolation.

- Disable settled in 231 ms after the command; frames continued, max gap 26.1 ms.
- A concurrent Templates call completed in 27.4 ms while the runaway was active.
- Unattended runaway reached its default budget in 1,060.5 ms, max frame gap 16.8 ms.
- Background/resume retained PID 18194; the runaway reached its budget in
  1,038.8 ms and a subsequent echo worked. Immediate cancellation at background
  transition was not observed.
- Remove settled in 279 ms, max frame gap 67.6 ms, and blocked later calls.
- Vault closure/restart changed PID 18194 to 18424 and reconnected in 1,713 ms.
  The old promise could not be observed after process exit. The new vault did
  not inherit approval, and returning to the original vault restored it.

The exact signed folder also passed Windows packaged lifecycle testing.
`windows-shared-signed-fixture.log.gz` records that run; the earlier five
packaged plugin checks are in `windows-packaged-plugins-rerun.log.gz`.
Windows used WebView2 155.0.4283.62; the driver warned that version 155 was
untested, and the tests completed successfully.

Reconstruct the shared folder by copying
`plugin-sdk/conformance/dist/conformance-rust.wasm` as `plugin.wasm` beside the
two files in `signed-fixture/`, removing their `.raw` suffixes.
The suffix keeps formatters from changing the signed manifest bytes.
The Wasm file's SHA-256 is
`5c6b4e5eb5dfdcc8b966a9b52b1741af944dceff05b574c53b4f98a041b7a614`.
The ephemeral signing private key is excluded. Pass the folder via
`MINDSTREAM_E2E_PLUGIN_FIXTURE` to the packaged lifecycle spec to reuse its
signature on Windows. The committed test otherwise generates an isolated key.

## Matching app measurements

`android-app-main-baseline.txt` and
`android-app-migration.txt` contain initial launch,
five force-stop cold activity draws, idle memory and 30 menu calls with
memory checkpoints. The menu has no template source configured in this
measurement protocol, so these calls produce a toast, not 500-note menus or
new notes. The full 500-note workload is in the runtime probe.

| Metric                                  |    Luau baseline |   Wasm migration |
| --------------------------------------- | ---------------: | ---------------: |
| Cold activity draw median, five samples |           186 ms |           199 ms |
| Idle 60 s PSS                           |      128,714 KiB |      122,894 KiB |
| First plugin call sampled PSS           |      137,755 KiB |      206,607 KiB |
| PSS after call 10                       |      144,784 KiB |      157,943 KiB |
| PSS after call 30                       |      145,375 KiB |      158,589 KiB |
| PSS after 20 s idle                     |      140,213 KiB |      153,311 KiB |
| Process VmHWM after call 30             |      152,640 KiB |      270,436 KiB |
| Normal signed ARM64 APK                 | 40,931,879 bytes | 51,256,335 bytes |
| Native library                          | 24,969,112 bytes | 35,293,568 bytes |

Activity `TotalTime` is first draw, not app ready or engine initialization.
The first plugin call compiles lazily and raises memory sharply. VmHWM is a
process high-water mark; dumpsys TOTAL RSS can include different accounting.
PSS checkpoints are sampled, not a continuous peak trace. These app-PID readings
do not aggregate separate WebView renderer processes. Calls 10 to 30 add
591/646 KiB PSS; this short run is insufficient to prove no memory retention.

The native library SHA-256 is
`85302d9db435a2d8a34a4c03a78fbdcd806165bd099936012b20cab66563083f`
for Luau and
`8b2fe906c4a067789959e0caac4eab848ef47e6913f89b77d9e67eafebcf67f6`
for migration. Both the signed APK and library increase by 10,324,456 bytes.
Gzip-9 library sizes are 13,283,565/17,052,014 bytes; xz sizes are
10,972,476/13,399,920 bytes. These are compression proxies, not AAB delivery
measurements. This normal ARM64 APK pair is within 15 MB. Other ABIs, AAB
delivery and desktop installer deltas remain open. Luau remains bundled.

The matching normal Windows x86_64 MSVC executables measure 31,163,392 bytes
for baseline and 42,630,656 bytes for migration, an increase of 11,467,264 bytes.
Both embed normal frontends and use the same Rust 1.97.1/MSVC toolchain,
opt-level `s`, LTO, stripping and Tauri CLI `build --no-bundle`, with no test
features. Baseline uses `2bdba0b4` plus the shared compatibility fixes; migration
uses `436f9b10`. `frontend-artifacts.json` records both embedded frontend trees.
The executable delta is below 15 MB uncompressed. This is not an installer
comparison; no macOS bundle comparison or desktop startup/process-memory
comparison is available. The normal Windows executables were built for size
measurement and were not launched against a user vault. Build logs and hashes
are preserved separately from the earlier packaged test binary.

The matching devtools release variants use WebView `performance.now()` around
invoke-to-result. CDP transport is outside this interval. Raw ordered samples
are `android-calls-main.jsonl` and
`android-calls-migration.jsonl`.

| App bridge timing                   |           Luau |           Wasm |
| ----------------------------------- | -------------: | -------------: |
| First render in cleared app         |       217.2 ms |     1,064.5 ms |
| Warm render p50 / p95, 100 calls    | 10.5 / 12.3 ms | 42.6 / 58.6 ms |
| Warm menu p50 / p95, 100 calls      |   8.3 / 8.6 ms | 51.0 / 64.2 ms |
| First render after process restart  |        11.1 ms |        70.5 ms |
| Render p95 after restart, 100 calls |        11.9 ms |        63.2 ms |
| plugins_list IPC p95, 100 calls     |         4.8 ms |         3.4 ms |

Runtime cached totals already exceed 5 ms for TypeScript and bundled plugins.
Inspection found `load_runnable` calling discovery, which collects and hashes
the selected package and clones its Wasm entry every time. Runtime cache
lookup also hashes component bytes. This is a profiling lead, not proof that
it accounts for the whole app gap. Approval/integrity validation must remain.

## CI and validation

- [Run 39480289063](https://github.com/jannikgohr/mindstream-notes/actions/runs/39480289063),
  revision `2303769c`, had passing desktop Rust and all three portable probes.
  JS failed on Node 20's QuickJS extended constant expressions. A later
  dispatch cancelled remaining work. `ci-status.json`, `ci-macos/`,
  `ci-windows/` retain this run's evidence; a successful Mac probe in this run
  does not erase the later budget failure.
- [Run 39482989588](https://github.com/jannikgohr/mindstream-notes/actions/runs/39482989588),
  revision `9115b342`, passed Rust on all three OSes, Linux/macOS Node 22,
  Linux coverage and all packaged-app suites. Windows JS had 12 failures
  caused by a Windows 8.3 TEMP alias becoming `%7E` in Vitest's loader.
  Canonicalizing `tmpdir()` reproduced and fixed the local 15-test SDK run.
  macOS's interpreter menu failed with Budget at 1,000 ms. Native Mac ran
  successfully but the old workflow did not upload reports after the later
  failure. `ci-node22-status.json` and gzipped failure logs preserve the result.
  The Mac runner was macOS 26.6.2/25G83 on image
  `macos-26-arm64`, version `20261013.0424.1`, with Rust 1.99.1
  `58cf8f9c3`. The Windows JS runner was Windows Server 2025 build 26100,
  image `windows-2025-vs2026` version `20261007.264.1`, Node 22.23.3.
  CI stable toolchains differ from this Windows host's Rust 1.97.1;
  those timing results are separate observations, not a controlled host comparison.
  CI CPU allocation, power and thermal state were not controlled or measured.
  The runner results do not replace representative desktop app measurements.
- [Run 39503424881](https://github.com/jannikgohr/mindstream-notes/actions/runs/39503424881)
  uses `436f9b10`. All three Rust workspace jobs, all three JS jobs and all three
  portable runtime jobs passed.
  Mac interpreter menu guest p95 was 621.63 ms, max 777.64 ms, with zero
  interrupted calls. Windows interpreter menu p95 was 591.85 ms, max 599.22 ms.
  The earlier Mac failure remains unexplained. `ci-final-status.json`,
  `ci-final-{macos,windows,ubuntu}/` and the final gzipped job logs record this
  run. The full workflow completed successfully, including the Linux single,
  multi and multi-a2 packaged-app suites. The single-suite raw log is retained
  as `ci-final-packaged-single.log.gz`.

The probe now saves successful samples and `budgetOverrunsMs`, writes JSON,
then exits unsuccessfully when any timed call exceeds its budget. Percentiles
exclude interrupted calls, whose counts/durations remain explicit; never
interpret those percentiles as an all-calls pass. Memory checkpoints distinguish
attempted and successful calls. CI uploads evidence after a failure.
`probe-overrun-check.json` and `.err` deliberately use 50 ms and three samples
to verify failure/reporting. That diagnostic is not release-budget evidence.

Local logs also preserve 3,580 frontend tests, 24 SDK/bundled tests, packed
Node-only author verification, Svelte check, workspace tests and clippy with
warnings denied. Windows workspace app tests passed 1,038 with six ignored,
runtime 70 and integration suites. Android runtime passed 75. Ignored tests
are not treated as passes. Runtime fmt/clippy/test checks cover the final probe
changes. Final CI remains necessary for platform changes.

## Reproduction and remaining gates

Use the physical-device procedure in [the migration document](../../wasm-plugin-migration.md).
The runner builds no emulator and runs each executable in a unique writable
temporary directory on the selected device. Native and interpreter commands
use release mode, `--iterations 100` and the unchanged default 1,000 ms.

The scripts in `tools/` preserve the app protocols. `measure.sh` uses
tablet-specific screen coordinates and clears only the two disposable test
app IDs. Pass its package, label and output path. `android-calls.mjs` expects
a freshly cleared devtools test app after onboarding; pass package and JSONL
output path. `android-lifecycle.mjs` takes the Wasm test ID, output path and
signed fixture folder. Node 22, adb on PATH and the installed devtools release
APK are prerequisites. Port 9334 is used for CDP. Do not use these data-clearing
protocols on a normal installation. The source fixture bytes/signature remain
unchanged across platforms.

Required work before Luau removal:

1. Resolve or explicitly accept the cached-total and full app-call regression.
2. Explain and resolve macOS interpreter budget failures without silently
   raising the one-second default; collect the corrected platform CI results.
3. Measure matching normal desktop app startup, idle/peak/repeated-call memory
   and installer/package deltas, including macOS and Windows.
4. Repeat Android measurements at representative charge/thermal states, use
   longer retention runs and measure interactive-ready startup and AAB/other
   release ABI sizes where those packages ship.
5. Establish immediate background cancellation if that is required. Current
   evidence proves timeout/recovery while backgrounded, plus vault process
   teardown, not settlement of an old promise after process exit.

No untested platform is marked passed. M6 remains blocked.
