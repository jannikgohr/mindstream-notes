# Android plugin validation, 24 October 2026

Tested at `98ce1e70`, following the
[validation procedure](../android-plugin-validation.md). The open latency
failure is [issue #116](https://github.com/jannikgohr/mindstream-notes/issues/116);
the [latency breakdown](android-plugin-profile-2026-10-24.md) explains it.

## Device

Samsung SM-T733 (SM7325, Android 14/API 34, ARM64; no physical ARMv7 CPU
tested), Android System WebView 156. USB powered at 100% charge, battery saver
off, thermal status 0 throughout. These are not battery-discharge measurements.

## Runtime

The release ARM64 runtime passed all 94 tests on the device, including hostile
batch lifting, maximum scalar arguments, UTF-8/UTF-16 results, trap recovery,
cancellation, permission denial, storage containment and Rust/TypeScript
parity. Native and Pulley probes ran 11,000 warm samples within the unchanged
1,000 ms budget with no overruns.

Native ARM64, 1,000 samples, in milliseconds:

| Workload                   | Cold prepare | Disk prepare | Cached p50 | Cached p95 | Guest linear bytes |
| -------------------------- | -----------: | -----------: | ---------: | ---------: | -----------------: |
| Rust echo                  |      163.704 |        0.506 |      0.055 |      0.097 |          1,179,648 |
| TypeScript echo            |      667.237 |        2.035 |      0.370 |      0.424 |          1,572,864 |
| Templates render           |       72.515 |        0.497 |      0.057 |      0.061 |          1,179,648 |
| Templates menu, 500 notes  |       77.253 |        0.506 |      2.755 |      2.815 |          2,097,152 |
| Typst without native tools |       66.303 |        0.388 |      0.046 |      0.075 |          1,179,648 |

Under Pulley the 500-note menu reached 51.5 ms p95; every other workload
stayed near or below 1 ms.

## Installed app

All 15 installed-app checks passed against the real WebView and Rust backend:
approval gating, settings and storage surviving force-stop, per-plugin storage
roots, denied traversal and undeclared native tools, cancellation of an active
runaway on disable/remove/permission-changing update, deadline termination
when backgrounded (not immediate cancellation), rejection of malformed, v1 and
Luau packages and of changed bytes with an old signature, and per-vault
approval. Replacing an installed `plugin.wasm` mid-call rejected new calls while
the active call kept its verified snapshot.

Templates visibility, folder picking and creation (including a plugin-owned
Typst note) passed. Typst reports its native tools unavailable and keeps source
editing; LanguageTool reports an unreachable endpoint clearly. Android hides
folder installation, so packages were installed through backend IPC.

## App IPC latency

Timed with `performance.now()` around the awaited invoke in the WebView, on a
release build with `tauri/devtools`:

| Cached app call                      | Samples | p50 ms | p95 ms | Max ms |
| ------------------------------------ | ------: | -----: | -----: | -----: |
| Signed third-party Rust echo         |     100 |   59.5 |   69.4 |   71.3 |
| Bundled Templates render             |   1,000 |    4.8 |    6.0 |   45.7 |
| Templates menu with two real sources |     100 |    5.8 |    6.2 |    7.3 |

The owner accepted a p95 below 10 ms as the goal. Across all 1,800 calls,
Templates render (6.3 ms) and menu (6.2 ms) pass; one 30-call render burst
reached 10.8 ms. Signed third-party echo fails at 68.8 ms p95 over 400 calls,
because each call goes through package discovery and integrity checks.

## Memory

1,800 calls over 11.8 minutes, alternating bursts and idle periods, with no
errors and stable process IDs:

| Checkpoint                 | Host + renderer PSS KiB | Host + renderer RSS KiB |
| -------------------------- | ----------------------: | ----------------------: |
| Idle before the call burst |                 197,196 |                 285,340 |
| After 1,200 calls          |                 210,522 |                 311,692 |
| After final 60-second idle |                 212,694 |                 313,720 |

PSS settled about 2 MiB above the post-burst checkpoint. That bounds retention
for this run; it does not rule out a leak over longer use.

## Startup and size

Five cold and five warm starts to an interactive Settings page took 7.7 s and
5.1 s at p50, against 7.0 s and 5.7 s for a pre-migration reference. The
samples are too small and too noisy to show a difference.
Against a matched pre-migration build at `2bdba0b4`, the APK shrank by 2.0 MB
and the AAB and estimated download grew by about 0.4 MB, well inside the 15 MB
budget.

## Summary

| Check                                         | Result     |
| --------------------------------------------- | ---------- |
| ARM64 runtime suite and release probes        | Pass       |
| Signed-package lifecycle and vault isolation  | Pass       |
| Templates, Typst and LanguageTool behaviour   | Pass       |
| Native `.typ` save through the Android picker | Fixed      |
| Templates app IPC p95 below 10 ms             | Pass       |
| Signed third-party app IPC p95 below 10 ms    | Fail, #116 |
| Package size within 15 MB                     | Pass       |
| Long-term and normal-build memory retention   | Open       |
| Physical ARMv7 or a second device             | Unmeasured |
| 32 MiB guest default under real workloads     | Unmeasured |
