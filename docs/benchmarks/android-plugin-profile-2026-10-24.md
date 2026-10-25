# Android signed-plugin latency breakdown

Follow-up to [physical validation](android-plugin-validation-2026-10-24.md).
Measured on the same Samsung SM-T733, Android 14/API 34, ARM64, WebView
156.0.8078.47. Production source is `98ce1e701b217d712c445c6c5b719f71712f2a02`
(including `b453278b943758d3ffbe0f43a1e826d78b264a0b`); profiling started
from docs-only commit `6f3e7615`. Temporary timers and a disposable application
ID were used in a release APK with `tauri/devtools`. No trust checks or the
1,000 ms runtime budget were removed. Instrumentation was subsequently reverted.

The earlier 68.8 ms p95 across 400 signed echo calls had no internal phase
timers. It cannot be decomposed retrospectively. The follow-up reproduced
the expensive stages, with lower total latency: consecutive calls reached
54.6 ms p95 with timers and 54.7 ms without timers, 100 samples each.
These are different runs, not a measured performance improvement.

## Where time goes

Dedicated consecutive signed echo block, 100 calls, 2026-10-25
00:21:50–00:22:18 UTC for the complete six-block experiment. The table uses
**means**, which add to the mean total; independently measured p95 phase
values must not be added. The first block includes its first call after
several hours idle, which reached 145.2 ms; its median was 52.0 ms.

| Stage                                   |    Mean ms | Owner and work                                                                                                                                             |
| --------------------------------------- | ---------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acquire package catalog root lock       |     20.085 | Rust app process; includes waiting                                                                                                                         |
| Recompute storage integrity hash        |     14.613 | Rust app process; reread 0.258, JSON byte-array serialization 6.660, SHA-256 7.678, small remainder                                                        |
| Read and verify package/component       |      6.526 | Rust app process; file reads 0.349, package digest 2.850, component snapshot/hash 2.718, Ed25519 verification 0.335, signature I/O/parsing/remainder 0.274 |
| Other native preparation and scheduling |      5.192 | Catalog/approval/remainder 2.273, notes/folders/settings 1.656, worker queue 0.629, other Rust handling 0.633                                              |
| Wasm worker                             |      0.822 | Blocking thread in the Rust app process; cached preparation 0.008, instantiation 0.275, guest/host calls 0.200, wrapper/remainder 0.339                    |
| Bridge, dispatch and response residual  |      4.105 | WebView ↔ Tauri boundary, including dispatch before the command timer and serialization/delivery after it                                                  |
| **Total**                               | **51.342** | JavaScript invoke through promise resolution                                                                                                               |

Rounding may affect the last digit. The residual does not separately measure
inbound IPC, outbound IPC, JSON serialization or JavaScript scheduling. Wasm
runs in a worker thread, not a separate plugin OS process. These are wall-clock
durations, not CPU utilization measurements.

`storage_hash` currently rereads the package and serializes binary file bytes
as JSON integer arrays before hashing. The separate verified-component snapshot
also hashes its bytes. This explains why hashing costs more than signature
verification or guest execution in this small 121,335-byte component.

## Lock sensitivity and controls

Each row contains 100 calls, in the order shown. A 50 ms interval is outside
the timed invocation; it is a diagnostic, not an optimization to ship.

| Block                                  | Mean ms | p50 ms | p95 ms | Maximum ms |
| -------------------------------------- | ------: | -----: | -----: | ---------: |
| Signed, timers enabled, consecutive    |  51.342 |   52.0 |   54.6 |      145.2 |
| Signed, timers disabled, consecutive   |  51.697 |   51.7 |   54.7 |       61.2 |
| Bundled Templates, timers enabled      |   6.253 |    5.9 |    6.5 |       34.8 |
| Bundled Templates, timers disabled     |   5.794 |    5.6 |    6.2 |       22.1 |
| Signed, timers enabled, 50 ms spacing  |  31.621 |   31.5 |   34.8 |       42.8 |
| Signed, timers disabled, 50 ms spacing |  30.929 |   31.1 |   33.3 |       36.1 |

Mean catalog-lock time fell from 20.085 ms to 0.247 ms with spacing.
`RootLock::acquire` sleeps 20 ms when its nonblocking OS lock reports contention.
The timings and spacing experiment are consistent with this retry cost.
The competing lock owner was not traced, so its identity and the precise
cause of the earlier 68.8 ms tail remain unmeasured.

The initial interleaved experiment (100 of each case, after 20 warmup pairs)
had signed control/profile p95 31.7/52.7 ms and bundled control/profile
29.5/7.2 ms. Those controls were confounded by call order/lock timing; the
dedicated blocks above resolve that ambiguity. Instrumentation overhead is
small in the dedicated blocks but is not a calibrated zero-overhead trace.
The initial run recorded 729 renderer frame gaps: p95 16.7 ms, maximum
33.2 ms, and no reported JavaScript long tasks. This is an idle-page async
probe, not a typing, scrolling, Android frame-timeline or field-INP benchmark.

## Realistic thresholds

- [Android responsiveness guidance](https://developer.android.com/topic/performance/anrs/keep-your-app-responsive)
  places perceived slowness around 100–200 ms. This describes user response,
  not a mandatory per-plugin RPC limit.
- [Android rendering guidance](https://developer.android.com/topic/performance/issues/render)
  gives frame budgets below 16 ms at 60 Hz, 11 ms at 90 Hz and 8 ms at 120 Hz.
  An asynchronous 70 ms request need not block the renderer for 70 ms.
- [web.dev INP guidance](https://web.dev/articles/optimize-inp) targets at most
  200 ms at the 75th percentile of page loads. INP measures interaction to next
  paint, so it is not interchangeable with p95 invocation completion latency.
- [Tauri IPC documentation](https://v2.tauri.app/concept/inter-process-communication/)
  describes asynchronous serialized request/response messaging and gives no
  numeric latency guarantee on that page.

Recommendation, rather than an external standard: retain **10 ms p95** as
the warm frequent editor-hook goal; use **50 ms p95** as an optimization target
for occasional asynchronous plugin commands, with **100 ms p95** for the whole
visible action. Measure render/typing responsiveness separately. A 70 ms async
command can be acceptable for an occasional action; it is expensive when
called repeatedly as part of editing. Prioritize the root-lock retry and
redundant package serialization/hashing, preserving generation, approval,
tamper, revocation and lease guarantees. No optimization was implemented here.

## Evidence and restoration

Raw data and reproducible scripts are in the ignored local folder
`.output/android-plugin-profile-2026-10-24/`: `raw-phases.json`,
`order-check.json`, `summary.json`, `order-summary.json`, `measure.mjs`,
`order-check.mjs`, `instrument.py`, `instrumentation.patch` and `profile.rs`.
The profiling APK SHA-256 is
`c28ecfd6954194721ee673e32b1c86fb49d44d3230525e7a8e8425463dce1102`.
The artifact is diagnostic and is not the normal-release validation build.
`SHA256SUMS` covers the follow-up evidence; its own digest is recorded in
`SHA256SUMS.sha256`. Original validation evidence was left unchanged.

The synthetic plugin was removed and the original normal signed APK set was
restored to the disposable application ID. The two pre-existing application
packages and their data were preserved. Temporary product-source edits were
reverted; only this report is committed.
