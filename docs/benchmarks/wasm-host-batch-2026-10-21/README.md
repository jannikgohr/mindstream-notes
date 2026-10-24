# General host batching comparison

The raw logs, data and scripts this report names are not in the repository.
They are in `mindstream-wasm-benchmark-evidence-f2f27a89.tar.gz`, under
`mindstream-wasm-benchmark-evidence/docs/benchmarks/wasm-host-batch-2026-10-21/`. The archive's
SHA-256 is `f371ed5c864ee308336e167b23ac29ffd6ceb8e9bf43ecc52384e75c72cb85f5`.

The parent revision is `14f35326`; the commit containing this report provides
the general host batch API, SDK support and three rebuilt Rust comparison
components. The shipped TypeScript Templates component remains unchanged.
Luau remains available and M5/M6 stay open.

## Scope and contract

This is a general typed operation batch over all 17 existing Wasm host calls,
not a calendar-only endpoint. It includes notes, private storage, runtime
helpers, Markdown, clocks and declared native tools. The executor delegates
to the scalar `HostContext` methods, retaining their permission, containment,
size and process rules. Backward text references can carry results across
interfaces. Only selected results return to the guest. Plans have count,
input and output limits; failures stop later operations with an index/cause,
and completed side effects remain. Cancellation/deadline remain fatal.
See [the API contract, example and design research](../../plugin-host-api-design.md).

The Rust batch candidate precollects date operations from title/body, sends
ordered plans and applies the returned strings. It does not deduplicate date
occurrences. A 128-command split and scalar fallback preserve larger inputs.
The scalar and guest-local Rust candidates are rebuilt from the same source,
including the identical mixed-workload plan. Their sizes differ from the
previous experiment, so this report uses the new matched controls rather
than combining historical percentiles. Legacy built components, including
the old TypeScript component, still passed compatibility/parity checks.
New components importing batch require a host that supplies it; stable public
ABI/version policy is still a release prerequisite.

## Protocol

All measurements ran in release mode through `plugin-sdk/android-runner.mjs`
on physical Samsung SM-T733, Android14/API34, ARM64 SM7325, Europe/Berlin.
The probe embeds all three candidate components and trusted Android/Pulley
artifact tables, with hashes in `artifacts.json` and the two manifests.
Rust 1.97.1, Wasmtime49.0.4 and NDK29/API26 match the preceding report's host.
The Windows host and CPU are documented in
[the optimization toolchain](../wasm-optimization-2026-10-21/toolchain.txt).

Round1 runs all 12 combinations of three implementations, two backends and
portable/AOT loading. Rounds2/3 repeat scalar versus batch AOT, with reversed
candidate order in round2, making 20 process invocations. Each case uses
100 samples, a fresh private case cache and the unchanged default 1,000 ms
budget. All attempts completed, all outputs matched and all exit codes were
zero. `summarize.py` validates these assertions and recreates `comparison.json`.
It does not pool percentiles from separate runs. Raw reports include each
sample, timing phase, cold observation and process memory checkpoint.

| Case              |              Scalar calls | Batch crossings | Work                                                                                                                                       |
| ----------------- | ------------------------: | --------------: | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Ordinary render   |                3 calendar |               1 | Title date plus shifted body date                                                                                                          |
| Date-heavy render |               61 calendar |               1 | Title date plus 20 two-offset expressions, no deduplication                                                                                |
| Mixed host plan   | 28 across five interfaces |               1 | Four repetitions of date add/format, note get, frontmatter, permission inspection, private write/read; text dependencies across interfaces |
| 500-note menu     |           1 metadata call |               1 | Same guest filtering/sorting in all candidates                                                                                             |

The mixed workload materializes the same plan on both paths and returns the
same selected results. The guest-local candidate uses scalar host operations
for this mixed workload; only its template dates are guest-local. Counts above
refer to the explicit guest imports in these fixtures, not Tauri/WebView IPC.

The tablet was USB charging, battery saver off, thermal status0, 32-32% charge,
with battery temperatures 31.4-31.5 C. Per-run before/after records are retained.
The operator previously reported normal temperatures; ambient temperature,
case and cooling were unobserved. The screen/app state is not a UI timing
measure: the disposable test app was stopped for probes and reopened afterward
without changing its installed package or data. Host builds ran concurrently
on Windows, not on the tablet. CPU frequency, temperature and power were not
controlled experiments, and repeated ordering is not randomized hardware
coverage.

## Results

The table gives ranges of the three separate per-run p95 totals, not confidence
intervals or a pooled p95. Totals include preparation, fresh instantiation and
guest execution, with host imports included; they exclude app discovery/IPC.

| AOT case                       | Scalar host calls |  General batch |
| ------------------------------ | ----------------: | -------------: |
| native templatesRender         |    0.062-0.167 ms | 0.063-0.068 ms |
| native templatesDateHeavy      |    0.533-0.545 ms | 0.564-0.570 ms |
| native hostMixed               |    0.831-0.848 ms | 0.792-0.812 ms |
| interpreter templatesRender    |    0.288-0.294 ms | 0.422-0.431 ms |
| interpreter templatesDateHeavy |    1.537-1.558 ms | 2.338-2.343 ms |
| interpreter hostMixed          |    2.064-3.102 ms | 1.912-1.930 ms |

Batching cut boundary count substantially, but date-heavy template rendering
was slower, about 50% in the interpreter. Ordinary native calls were tens of
microseconds, with a larger first-round scalar observation; later paired
rounds were close. The mixed plan's later paired rounds improved native totals
by about 4-5% and interpreter totals by about 7%, saving about 0.14-0.15 ms in
the interpreter. The first mixed scalar interpreter run had a 3.102 ms p95,
while later runs were about 2.064 ms. All observations are retained in the
range table and raw samples; do not generalize from the larger first-run gap.

Plan construction/lowering, result handling, validation and dispatch also cost
CPU. These are complete implementations, not an isolated measurement of one
boundary crossing. Cache-warm loops are short and do not establish steady CPU
frequency or thermal conditions. The unchanged metadata menu is a useful
control, but does not remove this timing noise. Batching every call by default
is not supported by these measurements.

The guest-local date-heavy AOT totals in round1 were 0.393 ms native and
11.257 ms interpreter. The batch candidate remains much faster than guest-local
dates in the interpreter, while scalar host dates are faster still. A native
host utility can outperform interpreted guest logic even when it has more
crossings. Native-only date-heavy workloads have a different tradeoff.

| Round1 native AOT size/memory    | Scalar Rust | Batch Rust | Guest-local Rust |
| -------------------------------- | ----------: | ---------: | ---------------: |
| Component bytes                  |   133,034 B |  137,844 B |      1,058,878 B |
| Cold render preparation          |   19.786 ms |  18.997 ms |        18.171 ms |
| Render guest linear memory       |   1.125 MiB |  1.125 MiB |        1.938 MiB |
| Menu guest linear memory         |   2.000 MiB |  2.000 MiB |        2.812 MiB |
| Process peak RSS after all cases |   8.930 MiB |  9.062 MiB |       10.059 MiB |

Cold preparation is one observation per case, not a startup percentile. All
portable control reports remain available. Guest linear memory differs from
process RSS, which includes compiler/code/host allocations. The new host
batch code exists in every control executable. This experiment compares using
it, not the release binary size cost of adding it. No new whole-app APK/EXE,
startup or app memory measurements are claimed. Earlier package-size gates
must be repeated for a host release that includes the new API.

## Checks and limits

The Windows workspace passed 1,038 app tests with six ignored, its integration
suites with one ignored integration case and 81 runtime tests before a final extra boundary test was added.
That test passed native and Pulley error propagation and prior-write behavior.
The final quiet runtime suite passed all 82 tests. It includes eight batch
executor tests for mixed capabilities, references, prevalidation, limits,
permissions, paths, native tool policy, cancellation and deadlines, plus
four-component template parity and multi-batch splitting. Seven guest calendar
tests passed. SDK/bundled tests passed all 27, including a compiled QuickJS
batch client and indexed error handling. Workspace/guest clippy with warnings
denied, Rustfmt, SDK typecheck and scoped ESLint passed.

One intermediate debug runtime run failed the existing interpreter host-report
test with `Budget` while host compilation was active. The complete failure log
is retained alongside passing workspace and final quiet-run logs. This is
consistent with the previously observed contention sensitivity; it does not
prove an isolated cause. The passing rerun does not establish budget reliability.
No timeout was raised. Physical release probes had zero overruns, and the
broader interpreter reliability gate remains open. The frontend check found no errors/warnings, and all 3,583 frontend/SDK tests
passed in 301 files. The new host addition has
not yet passed new macOS/Linux app release checks or package measurements.

## Reproduction

Build all three components with Node22:

```text
node plugin-sdk/prototypes/templates-rust/build.mjs
node plugin-sdk/prototypes/templates-rust/build.mjs --batch-host
node plugin-sdk/prototypes/templates-rust/build.mjs --local-calendar
```

Stage each component with a compiler-only manifest containing `id`,
`runtime: "wasm"` and `entry: "plugin.wasm"`. Use `plugin-precompile` for
`aarch64-linux-android` and `pulley64`, combine the generated Rust arrays, and
point `MINDSTREAM_PROBE_PRECOMPILED` at that absolute file. Use the documented
NDK/API26 linker and build `plugin-bench` with `--release --target
aarch64-linux-android --features probe-precompiled`. `run.ps1` executes the
20 processes with the exact flags and conditions capture. It requires the
recorded timezone; validate parity before adapting to another zone.

`SHA256SUMS` covers this folder except itself. Artifact hashes identify the
local executables/components; the probe executable is not committed. JSON
reports are pretty-printed without changing values, and compressed raw build/
test logs retain original bytes. `diagnostic-initial-probes.tar.gz` preserves
the first complete run before the final argument-limit/exhaustive-error checks;
it is excluded from the main tables. The final reports use the final probe hash. See the design guide for the typed operation
contract, SDK example, architectural recommendations and primary sources.
