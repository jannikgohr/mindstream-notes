# Android signed-plugin latency breakdown

Performance follow-up: [issue #116](https://github.com/jannikgohr/mindstream-notes/issues/116)
tracks lock contention, repeated hashing and third-party editor responsiveness.

Follow-up to [physical validation](android-plugin-validation-2026-10-24.md),
on the same Samsung SM-T733 (Android 14, ARM64, WebView 156) at
`98ce1e70`. Temporary phase timers ran in a release APK with
`tauri/devtools`, with all trust checks and the 1,000 ms budget intact; they
were reverted afterwards. Consecutive signed echo calls reached 54.6 ms p95
with timers and 54.7 ms without, 100 samples each.

## Where time goes

100 consecutive signed echo calls. The table uses **means**, which add to the
mean total; p95 phase values must not be added.

| Stage                                   |    Mean ms | Owner and work                                                                                                                                             |
| --------------------------------------- | ---------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acquire package catalog root lock       |     20.085 | Rust app process; includes waiting                                                                                                                         |
| Recompute storage integrity hash        |     14.613 | Rust app process; reread 0.258, JSON byte-array serialization 6.660, SHA-256 7.678, small remainder                                                        |
| Read and verify package/component       |      6.526 | Rust app process; file reads 0.349, package digest 2.850, component snapshot/hash 2.718, Ed25519 verification 0.335, signature I/O/parsing/remainder 0.274 |
| Other native preparation and scheduling |      5.192 | Catalog/approval/remainder 2.273, notes/folders/settings 1.656, worker queue 0.629, other Rust handling 0.633                                              |
| Wasm worker                             |      0.822 | Blocking thread in the Rust app process; cached preparation 0.008, instantiation 0.275, guest/host calls 0.200, wrapper/remainder 0.339                    |
| Bridge, dispatch and response residual  |      4.105 | WebView ↔ Tauri boundary, including dispatch before the command timer and serialization/delivery after it                                                  |
| **Total**                               | **51.342** | JavaScript invoke through promise resolution                                                                                                               |

`storage_hash` rereads the package and serializes binary file bytes
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
The competing lock owner was not traced.

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
tamper, revocation and lease guarantees.
