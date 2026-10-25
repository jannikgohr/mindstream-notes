# Android plugin validation, 24 October 2026

Tested source: `98ce1e701b217d712c445c6c5b719f71712f2a02`, including
`b453278b943758d3ffbe0f43a1e826d78b264a0b`. This follows
[the Android handoff](../android-plugin-validation.md). Work is isolated on
`tests/android-plugin-validation`; the implementation branch was not changed.

## Device and tools

Samsung SM-T733, serial `R52W103DQPB`, SM7325 SoC, Android 14/API 34,
ARM64. The device also advertises ARMv7 compatibility; no physical ARMv7 CPU
was tested. WebView is `com.google.android.webview` 156.0.8078.47. OS build:
`samsung/gts7fewifieea/gts7fewifi:14/UP1A.231005.007/T733XXS9DYF1:user/release-keys`.

The initial conditions were 100% charge, USB powered, battery status full,
battery saver off, battery 30.9 °C, AP 32.8 °C and thermal status 0.
After the 1,000-iteration runs, AP temperature reached 40.2 °C with thermal
status still 0. Raw before/after records accompany each longer run; these
are USB-connected measurements, not battery-discharge measurements.

Windows host, Node 22.21.1, pnpm 10.34.4, rustc 1.97.1, cargo 1.97.1,
Temurin Java 21.0.2, NDK 29.0.14206865 and adb 36.0.0. Node 20 was the
shell default. Runtime fixture builds explicitly selected Node 22 through
`NODE`. Initial pnpm/Gradle wrappers still reported Node 20 for their own
processes; a local pnpm wrapper then pinned Node 22 for subsequent commands.
The frontend supports either Node version. No Node 20 fixture result is
counted as SDK/runtime validation.

The Android test application ID is
`com.jannikgohr.mindstream_notes.android_validation`. The Gradle application
ID and fully qualified manifest Activity are the only isolation changes.
Existing `.wasm_m5` and `.main_check` apps and their data were preserved.

## Runtime results

The release ARM64 runtime binary passed all 94 tests on the physical device,
including hostile batch lifting, maximum scalar host arguments, UTF-8/UTF-16
results, trap recovery, cancellation, permission denial, storage containment,
batch progress/recovery and Rust/TypeScript parity. No test was filtered out.
The direct test run took 13.64 seconds. The corrected `cargo test` command
also passed all 94 tests in 13.81 seconds, followed by zero doctests.
ARM64 release Clippy passed with `-D warnings`, and workspace formatting
passed. Six targeted frontend/SDK suites passed all 319 tests.

The first `cargo test` launch failed before executing tests because Cargo split
a runner path containing spaces. Its complete output is retained in
`runtime-tests.txt`. The identical compiled binary then ran successfully via
`node plugin-sdk/android-runner.mjs <binary> --test-threads=1`.
The corrected Cargo runner uses an absolute junction path without spaces.

Both native and Pulley release probes passed at 100 and 1,000 iterations per
workload. Five workloads ran in each report, for 11,000 warm samples across
the four reports. All used the unchanged 1,000 ms workload budget, with zero
overruns. Cancellation, timeout and memory-refusal controls also passed.
Their deliberate shorter timeout/memory limits are recorded separately in
the probe's control results and do not change the workload budget.

Native ARM64 results below are from the 1,000-sample report, in milliseconds.
Cold preparation, disk loading and cached calls are separate measurements.

| Workload                   | Cold prepare | Disk prepare | Cached p50 | Cached p95 | Cached max | Guest linear bytes |
| -------------------------- | -----------: | -----------: | ---------: | ---------: | ---------: | -----------------: |
| Rust echo                  |      163.704 |        0.506 |      0.055 |      0.097 |      1.087 |          1,179,648 |
| TypeScript echo            |      667.237 |        2.035 |      0.370 |      0.424 |      0.528 |          1,572,864 |
| Templates render           |       72.515 |        0.497 |      0.057 |      0.061 |      0.146 |          1,179,648 |
| Templates menu, 500 notes  |       77.253 |        0.506 |      2.755 |      2.815 |      2.893 |          2,097,152 |
| Typst without native tools |       66.303 |        0.388 |      0.046 |      0.075 |      0.381 |          1,179,648 |

Pulley p95 cached totals at 1,000 samples were 0.195 ms for Rust echo,
1.122 ms for TypeScript echo, 0.331 ms for Templates render, 51.541 ms for
the 500-note menu and 0.124 ms for Typst without native tools. Guest linear
memory was the same as the native cases.

These are standalone runtime measurements. They do not establish app IPC,
interactive startup, whole-app retention or physical ARMv7 performance. The
guest-memory numbers are allocated linear memory, separate from RSS/PSS.

## Evidence

Raw evidence is kept outside Git at:

```text
C:\Users\janni\.t3\worktrees\Tauri Note-Taking App\tests-android-plugin-validation\.output\android-plugin-validation
```

It contains full build/test output, device conditions, extracted JSON reports,
test and probe executable hashes, signed-package bytes, and test scripts.
Private signing material is excluded from the evidence checksum manifest.
Artifact hashes and application results follow below.

## Installed application checks

The normal release APK and AAB built successfully with the real frontend and
trusted bundled precompilation. The generated artifact table contains two
precompiled guests. A separately retained release APK adds `tauri/devtools`
for WebView IPC inspection. Its timings are labelled as instrumented results;
normal-build startup, size and memory samples use the normal APK/APK set.

The installed-app IPC suite passed all 15 checks after correcting its first
test script. It exercises the physical Android WebView and the real Rust
backend, not browser fallback mocks or the desktop WebDriver suites.

- Signed package installation is gated until approval. Settings, approval and
  TypeScript guest storage survive force-stop/relaunch. A second Rust plugin
  sees its own storage root, not the TypeScript plugin's stored value.
- The guest sees real note metadata. Storage traversal and undeclared native
  tools are denied.
- Disable, remove and a permission-changing update cancel an active runaway.
  The WebView continues producing frames and an unrelated Templates call
  succeeds before cancellation. Re-enable/reapproval restores execution.
- An unattended runaway stops at the default deadline. Background/resume keeps
  the same app process and leaves the guest usable afterwards. The observed
  background outcome is deadline termination, not immediate cancellation.
- Missing entries, `plugin..wasm`, manifest v1 and Luau packages are rejected.
  A package with changed manifest bytes and its old signature is installed
  gated, reports `signatureStatus: invalid`, and cannot enable or execute.
- Vault switching during a runaway restarts into the other vault. Approval
  does not carry over. After separately approving the storage fixture there,
  its store is empty. Switching back restores the original approval and value.
- Typst reports its compiler and tinymist unavailable on Android, keeps source
  editing usable, and returns exact `.typ` source bytes. LanguageTool declares
  manifest v2 with `runtime: manifest-only`; an unreachable local endpoint
  returns a failed connection result with a useful detail.

The Templates UI then passed visibility, real folder-picker persistence,
markdown creation and plugin-owned Typst creation checks. Without a configured
source, the action is hidden. Selecting the seeded `Android templates` folder
makes it available. Choosing its source creates a distinct note with rendered
title/date while preserving the source. The Typst copy keeps its note kind.
Editing that copy through the actual CodeMirror/WebView input path persists
across force-stop; `.typ` export returns the exact edited text.

The unattended runaway produced 61 frames and stopped after 1,013.9 ms,
with a 16.7 ms largest frame gap. Disable/update/remove runs continued
producing frames but had maximum foreground gaps of 99.6/83.0/133.0 ms;
these are not evidence of steady 60 fps during package operations. The
backgrounded run reached its deadline after 1,018.4 ms. Its 2,410 ms frame
gap includes time spent in the background, where animation frames pause.

Folder installation is hidden by the Android UI. The signed packages were
staged in this disposable app's cache and installed/approved through backend
IPC in the devtools build. This does not prove an Android folder-picker flow.
The guest `.typ` assertion covers correct export bytes and the real source
editor. A separate native save check failed, as described next.

Direct installed-file tampering also passed. After starting a runaway, the
test replaced its installed `plugin.wasm` with invalid bytes. New calls were
rejected, while the active call kept its verified snapshot and reached its
deadline after 1,060.3 ms. Restoring the exact original bytes restored
execution. This used only the disposable application's package directory.

Visible assertions have screenshots and DOM transcripts, including
`normal-shell.png`, `templates-hidden.png`, `templates-configured.png`,
`templates-visible.png`, `templates-created-markdown.png`,
`templates-created-typst.png` and `typst-edited-source.png`.

## Native source-save failure

The subsequent [document-URI save fix and device retest](android-export-fix-2026-10-25.md)
resolve this failure. The results below describe the original failing build.

The devtools release passed Typst's export bytes into the real
`save_file_export` command, then used Android's document picker to save a
uniquely named `.typ` file in Downloads. The app returned:

```text
invalid argument: path conversion: URL is not a valid path
```

The picker created a zero-byte file; the source bytes were not written. The
test file was removed afterwards. `native-export-result.json`, picker XML,
`native-export-created-file.txt` and screenshots retain the failure.

The failure is in the shared native save bridge in
`src-tauri/src/pdf_export.rs`: it calls `FilePath::into_path()` on the picker
result, and its source explicitly notes that mobile document URIs are not
supported. Correct guest export output therefore does not establish a working
Android Save flow. The bridge needs document-URI writing through Android's
content resolver. No product fix was included in this validation branch.

## App IPC latency

Calls are timed with `performance.now()` around the awaited Tauri invocation
inside the physical WebView. The host supplies real settings, folders and
notes. Preparation/discovery can occur before these calls, so none is labelled
cold compilation. Runtime compilation, disk loading, instantiation and guest
execution remain separately available in the standalone JSON reports.

| Cached app call                      | Samples | p50 ms | p95 ms | Max ms | Errors |
| ------------------------------------ | ------: | -----: | -----: | -----: | -----: |
| Signed third-party Rust echo         |     100 |   59.5 |   69.4 |   71.3 |      0 |
| Bundled Templates render             |   1,000 |    4.8 |    6.0 |   45.7 |      0 |
| Templates menu with two real sources |     100 |    5.8 |    6.2 |    7.3 |      0 |

The owner accepted a p95 threshold below 10 ms during this run. The initial
Templates render and menu measurements pass that threshold; both exceed the
historical target below 5 ms. Signed third-party echo still fails the accepted
10 ms threshold. Standalone guest timings do not close that application gap.
The signed path performs
package discovery/integrity checks through `load_runnable`, `discovery::find`
and `packages::discover` on each invocation. That path is a candidate for
profiling, not a measured attribution of the latency. No integrity check,
assertion or production budget was removed to improve these numbers.

Across all 1,800 calls, render p95 was 6.3 ms for 1,300 samples, menu p95
was 6.2 ms for 100 samples, and signed echo p95 was 68.8 ms for 400 samples.
Thus the aggregate Templates calls pass the accepted 10 ms target. One
30-call render batch reached p95 10.8 ms; aggregate acceptance does not mean
every short burst or individual call stayed below 10 ms.

## Memory and repeated-use soak

The devtools release completed 1,800 app IPC calls over 706.779 seconds,
about 11.8 minutes. The first burst included 1,000 render calls, 100 signed
echo calls and 100 menu calls. Twenty subsequent checkpoints alternated
30 echo/render calls after 30-second idle periods, followed by a 60-second
idle period. No call failed and both process IDs remained stable.

Process selection uses ActivityManager's exact application `packageList`,
including its isolated WebView renderer. `dumpsys meminfo` provides each
process's PSS/RSS; `/proc/<pid>/status` provides its own `VmHWM`. PSS is
apportioned across shared pages. Summed RSS can double-count them. The
separate per-process high-water marks are not a simultaneous whole-app peak.

| Checkpoint                 | Host + renderer PSS KiB | Host + renderer RSS KiB |
| -------------------------- | ----------------------: | ----------------------: |
| Idle before the call burst |                 197,196 |                 285,340 |
| After 1,200 calls          |                 210,522 |                 311,692 |
| First soak checkpoint      |                 210,310 |                 311,500 |
| Twentieth soak checkpoint  |                 212,786 |                 313,812 |
| After final 60-second idle |                 212,694 |                 313,720 |
| Highest sampled total      |                 213,212 |                 314,244 |

Host PID 4423's `VmHWM` stayed at 151,660 KiB. Renderer PID 4513's high-water
mark rose from 109,364 to 113,268 KiB. Guest linear memory remains a separate
runtime metric, 1.125–2 MiB for the measured native workloads.

PSS retained about 15.1 MiB above the initial idle checkpoint and about
2.1 MiB above the post-burst checkpoint after the final idle. This is a
bounded observation, not proof that retention is flat or that no leak exists.
The devtools/measurement scripts also allocate in the renderer. Longer runs,
normal-build retention, and larger third-party workloads remain open.

The tablet stayed USB powered at 100% charge, battery saver off and thermal
status 0. The AP temperature went from 34.0 to 33.3 °C during the soak;
battery temperature stayed 32.1 °C. The screen timeout was temporarily set
to 15 minutes for this run and restored to its original 30 minutes.

A normal delivered-build idle sample was 196,136 KiB PSS/283,872 KiB RSS.
The older reference was 220,684/310,268 KiB, with a different note/profile
state, so this does not establish a matched memory improvement. A final
normal-build launch after testing measured 200,310/286,480 KiB before the
separate native save check.

## Normal-build startup

Five cold-process and five warm-resume samples each required Settings to
accept a tap and render `Account & Sync` and `General`. The stopwatch starts
before `am start`; results include ADB commands, accessibility-dump generation
and polling. They are observed readiness bounds, not precise frontend-ready
timestamps. Cold means a force-stopped process with the OS page cache intact.
Activity first-draw timings are retained separately and are not counted as
interactive readiness.

| Build                           | Mode         |   n | Observed p50 ms | Observed p95/max ms |
| ------------------------------- | ------------ | --: | --------------: | ------------------: |
| Current normal release          | Cold process |   5 |         7,700.8 |             8,616.9 |
| Current normal release          | Warm resume  |   5 |         5,119.7 |             5,194.8 |
| Patched pre-migration reference | Cold process |   5 |         6,998.2 |             8,210.5 |
| Patched pre-migration reference | Warm resume  |   5 |         5,743.0 |             6,121.3 |

These small samples with coarse automation overhead do not establish a
startup regression or improvement. The current onboarding created a welcome
note; the older backend ignored the new demo-note payload and started empty.
That profile mismatch also prevents a strict baseline memory comparison.

## Package size

The reference starts at
`2bdba0b4a34bd1ffd8af65db85de0065fd107fdb`. It uses the same compiled
frontend tree, ARM64 ABI, release profile, SDK/NDK, signing certificate and
disposable application ID as the current build. Shared Android startup fixes
add the mobile shortcut guard and the flock-backed root/vault/package locks.
The exact patch and added `baseline-file_lock.rs` are retained in the evidence.
Other native changes merged since that revision remain a confound for
attributing every byte specifically to the plugin migration.

Both builds use frontend manifest SHA-256
`77035ae5c6e190d57c9b82a8201d7106f0e61a037b17efca0861c770489df101`.
Both APK signatures verify against the same certificate. Device-targeted APK
sets use bundletool 1.18.3 and the recorded tablet ABI, locale and density.
Both sets were installed successfully; code bytes sum the APK files actually
reported by `pm path`, excluding app data and OS-generated compilation caches.

| Artifact/measurement               | Pre-migration bytes | Current bytes | Change bytes |
| ---------------------------------- | ------------------: | ------------: | -----------: |
| ARM64 APK                          |          55,022,063 |    52,979,619 |   -2,042,444 |
| ARM64 AAB                          |          35,734,710 |    36,115,643 |     +380,933 |
| Main native library, uncompressed  |          39,059,304 |    46,323,040 |   +7,263,736 |
| Device-targeted estimated download |          35,177,153 |    35,560,446 |     +383,293 |
| Installed APK files                |          61,589,589 |    59,545,609 |   -2,043,980 |

The observed differences are below the historical 15,000,000-byte added-size
target. The older APK also packages `libc++_shared.so`, 9,290,184 bytes,
which is absent from the Wasm-only APK. This explains why the main library
grows while the complete APK shrinks. The download result is bundletool's
device-specific compressed estimate, not a measured Play Store transfer.

## Failed setup attempts retained

- `runtime-tests.txt`: runner quoting failed before any test executed. The
  identical binary passed directly and the corrected Cargo command also passed.
- `baseline-build-rejected-absolute-url.txt` and
  `rejected-baseline-absolute-url.apk`: an absolute Windows frontend path was
  interpreted as a URL, causing `ERR_UNKNOWN_URL_SCHEME`. That artifact is
  excluded from comparisons. A relative frontend path fixed the reference;
  its shell and Settings action then passed on-device.
- `normal-apkset-unsupported-env-attempt.txt`: this bundletool version accepts
  password files, not environment references. A temporary private password
  file, deleted after the command, fixed APK-set generation.
- `normal-startup-attempt1.txt`: UiAutomator exited 137 after reporting that
  it had written the XML dump. Subsequent collection validates the newly
  generated XML; all ten recorded readiness actions passed.
- `app-validation-attempt1.txt`: the first script expected echo to omit the
  backend's settings/folders/clock and expected installation to reject an
  invalid signature. Existing product tests require context injection and
  signature gating instead. Correcting those assertions gave 15/15 passes.
- `templates-ui-attempt*.txt`: setup needed to wait for the new WebView after
  navigation and use the mobile action menu's explicit Close button. No
  product assertion or visibility rule was relaxed.
- `verified-snapshot-attempt1.txt`: the safety guard expected a trailing slash
  on Android's app-data path. It stopped before writing. Accepting the exact
  disposable app root allowed the installed-byte tamper test to pass.

The successful normal-build samples, valid relative-path baseline and final
passing app checks are retained alongside these attempts.

## Commands and artifact identity

Windows environment adaptation is retained in `env.ps1`, including the NDK
API-26 linker for the standalone runtime and a runner path without spaces.
The normal Tauri Android builds use their normal generated NDK configuration.
The separate application ID patch is in `disposable-app-id.patch` and was
restored in the checkout after creating the artifacts.

```powershell
. .output/android-plugin-validation/env.ps1
pnpm install --frozen-lockfile
cargo test --manifest-path src-tauri/Cargo.toml --locked --release `
  --target aarch64-linux-android -p mindstream-plugin-runtime `
  -- --test-threads=1
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --release `
  --target aarch64-linux-android -p mindstream-plugin-runtime -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo build --manifest-path src-tauri/Cargo.toml --locked --release `
  --target aarch64-linux-android -p mindstream-plugin-runtime --example plugin-bench
node plugin-sdk/android-runner.mjs `
  src-tauri/target/aarch64-linux-android/release/examples/plugin-bench --iterations 100
node plugin-sdk/android-runner.mjs `
  src-tauri/target/aarch64-linux-android/release/examples/plugin-bench `
  --interpreter --iterations 100
# Repeat each probe with --iterations 1000.
pnpm tauri android build --target aarch64 --apk --aab
pnpm tauri android build --target aarch64 --apk --features tauri/devtools `
  --config .output/android-plugin-validation/devtools-config.json
node .output/android-plugin-validation/app-validation.mjs
node .output/android-plugin-validation/templates-ui.mjs
node .output/android-plugin-validation/typst-edit.mjs
node .output/android-plugin-validation/app-perf.mjs
```

`app-validation.mjs` expects completed/skipped onboarding and the signed
fixtures next to it. The signing key is local private test material and is
excluded from the checksum manifest; existing signatures and public package
bytes suffice to reuse the recorded packages on another platform. The scripts
and raw command transcripts retain the bootstrap, fixture build, signing,
bundletool and baseline build details.

| Artifact                            | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| Current normal APK                  | `55c7202dea3fc1020a1ba9cc92afe8f1621a791e654fe2d6e7401b1ea95edd23` |
| Current normal AAB                  | `bc8e66f9970cdeb6b83fb0922328324f1a1c17b5d055bcaabca6e64c0e7c7d79` |
| Current device APK set              | `350ff30c778a62bdbaa8a550d8635445a89587fa3d94c4cce797b0097358a2da` |
| Current devtools APK                | `eb016c98178f904eb4331b41102ca2ccff13f7eebc2a900bf2fa1979560bff93` |
| Patched baseline APK                | `c71bc8edb891f24bce2694f22493e583997423521dbaad5f2a86682ec53aa05e` |
| Patched baseline AAB                | `2203615942142b07ae1e6487c3033613b284d2d7733f041ab3441ab3d5a46e2d` |
| Patched baseline device APK set     | `b4df9ff3b9d7b919dd6a6eff3afbc7eb6121c4af269343eb064a72adeb8b8899` |
| ARM64 runtime test binary           | `78491c3724bdb1be713b15ede69cb620bc7960f3b25f9c3d9cd93926eebf7ec6` |
| ARM64 release probe                 | `957e1043451e885b884453a0698fbbc91be7504ba208164c98c8187a81389432` |
| Signed Rust conformance component   | `bae99ef5205aef1a2d7d902c4ba92a531841aad89d406ea9822f129bd5693ef6` |
| Signed TypeScript storage component | `bce9fb5a1fead18cd77fe97854a46dfacdece91d93d22fb27e9674cd8df7abf7` |

`artifact-summary.json` also records byte counts and hashes of the native
libraries extracted from each APK/AAB. `SHA256SUMS` covers the public packages,
scripts, transcripts, screenshots and measurements, excluding itself and
private signing material.

## Pass/fail/unmeasured summary

| Check                                                     | Result     | Scope or remaining issue                                                   |
| --------------------------------------------------------- | ---------- | -------------------------------------------------------------------------- |
| ARM64 runtime suite                                       | Pass       | 94/94, plus formatting and release Clippy                                  |
| Frontend/SDK plugin suites                                | Pass       | 319/319                                                                    |
| Native/Pulley release probes                              | Pass       | 11,000 warm samples, no workload budget overruns                           |
| Signed-package lifecycle and vault isolation              | Pass       | 15 installed-app checks                                                    |
| Installed-byte tamper during active execution             | Pass       | Old snapshot retained; new calls rejected; recovery verified               |
| Templates visibility and note creation                    | Pass       | Real picker, date/title substitution, distinct notes and preserved sources |
| Typst source editing and guest export bytes               | Pass       | Edited source persists across process death                                |
| Native `.typ` Save through Android picker                 | Fail       | Path conversion error; zero-byte file                                      |
| Typst/LanguageTool unavailable-service behavior           | Pass       | Native tools absent; usable source editing and explicit connection failure |
| Templates app IPC p95 below owner-accepted 10 ms          | Pass       | Aggregate render 6.3 ms; menu 6.2 ms; short-burst tails recorded           |
| Signed third-party echo app IPC p95 below 10 ms           | Fail       | 68.8 ms across 400 calls                                                   |
| Observed package-size differences below 15 MB             | Pass       | Matched frontend/packaging; native revision confounds documented           |
| Startup accepts an input action                           | Pass       | Five cold-process and five resume samples per build                        |
| Precise startup comparison without automation overhead    | Unmeasured | Readiness bounds include accessibility/ADB overhead and profile mismatch   |
| 1,800-call repeated-use run                               | Pass       | 11.8 minutes, zero errors, stable process IDs                              |
| Long-term/normal-build retention closure                  | Open       | Measured retained memory; this bounded devtools soak cannot close it       |
| Physical ARMv7 or second device                           | Unmeasured | Only the connected ARM64 tablet was available                              |
| 32 MiB default under representative third-party workloads | Unmeasured | Conformance/storage fixtures are synthetic workloads                       |

The two observed failures are the native document-save bridge and signed
third-party app IPC latency. The original production budgets and all product
assertions are unchanged. The normal release was restored on the disposable
app ID, synthetic signed packages were removed, and the two pre-existing
Mindstream test apps were preserved.

The public evidence manifest contains 429 files. Its SHA-256 is:

```text
98ab42bd5a468c25702bd7247f39e7b87635867561f7ed14449916a8779e9b8d
```
