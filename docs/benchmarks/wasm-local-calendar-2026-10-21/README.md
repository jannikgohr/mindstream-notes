# Rust guest-local calendar comparison

The raw logs, data and scripts this report names are not in the repository.
They are in `mindstream-wasm-benchmark-evidence-f2f27a89.tar.gz`, under
`mindstream-wasm-benchmark-evidence/docs/benchmarks/wasm-local-calendar-2026-10-21/`. The archive's
SHA-256 is `f371ed5c864ee308336e167b23ac29ffd6ceb8e9bf43ecc52384e75c72cb85f5`.

The parent revision is `12937886`; the commit containing this folder contains
the candidate and comparison code. The shipped Templates plugin stays
TypeScript. Luau remains available and no release gate is closed by this test.

## Candidate and question

The existing Rust prototype imports `clock.add` and `clock.format` for template
dates. The second candidate, `plugin-local-calendar.wasm`, performs that work
inside Wasm. It shares the original template/menu implementation through the
`local-calendar` feature, keeps the existing exports/effects, and still uses
host notes metadata and UUID capabilities. Date rendering adds an explicit
IANA `input.timeZone`; it refuses missing/unknown zones instead of substituting
a fixed offset. The production app does not yet supply that extra context,
so this is a benchmark candidate, not a drop-in shipped plugin.

The guest calendar code copies the current host formatter and arithmetic,
including German/English names, clamped months/years, elapsed 24-hour day/week
shifts, and preserving the original time for month shifts into a DST gap or
fold. A constant offset is insufficient for destination-date DST rules. The
candidate embeds all chrono-tz 0.10.4 zones, IANA 2025b. That database can lag
OS updates. Shipping it would need a timezone-data update policy and broader
zone/version parity checks. See the [prototype instructions](../../../plugin-sdk/prototypes/templates-rust/README.md).

## Protocol and validation

All three components ran through `plugin-sdk/android-runner.mjs` in separate
physical ARM64 Android processes, portable and trusted AOT, native and Pulley.
Each run used 100 samples per export, fresh private case caches and the default
1,000 ms guest budget. No budget was raised and no attempts were interrupted.
The probe uses immutable static component bytes, so recurring digest work is
controlled. The same probe executable embeds all three components and both
trusted target artifact tables. Its hash and all component hashes are in
`artifacts.json`. The two AOT manifests record artifact sizes,
hashes and matching engine keys. `run-status.json` retains all arguments,
timestamps and exit codes. `summarize.py` checks matching outputs, sample counts,
budgets, build mode, timezone and expected Compiled/Bundled first-use sources.

Ordinary render has a date in its title and one shifted date in its body:
three calendar calls in the host-backed variants, zero in the local candidate.
The date-heavy case adds 20 expressions with two offsets each, plus a date in
the title: 61 calendar calls versus zero. This is a stress comparison, not a
claim about a typical note. All variants also build the same 500-note menu;
that path calls notes metadata once and has no date calculations. It exposes
size/memory costs even when the calendar feature is unused.

Guest tests passed seven cases, including all formatting tokens, leap/month
clamping, invalid input/overflow, a non-European zone, DST gaps/folds and the
required-zone contract. The Windows runtime passed all 73 tests with none
ignored, including three-component parity at the actual host IANA timezone.
Those tests use native execution in debug mode. The physical release probes
cover both backends and validate identical outputs for all measured inputs.
New candidate macOS/Windows release-runtime and whole-app measurements are not
claimed. Rustfmt and clippy with warnings denied passed for the runtime and
candidate, including the wasm32 guest target. Raw build/test/check logs are
retained under `logs/`.

The device is the same Samsung SM-T733, Android 14/API 34, SM7325 ARM64,
Europe/Berlin, with Rust 1.97.1, Wasmtime 49.0.4 and NDK r29/API26. See
`toolchain.txt` and the per-run before/after conditions. Runs were sequential,
USB charging, battery saver off and thermal status 0. The operator previously
reported normal temperatures; ambient temperature, case and cooling remain
unobserved. Charge was 30-31% and battery temperature was 31.3-31.5 C. CPU frequency
and timing noise were uncontrolled. These are observations from one tablet,
not randomized trials or a universal platform ranking.

## Results

Warm totals include preparation, fresh instantiation and guest execution.
They exclude app IPC/discovery. Cold preparation is a single observation per
case, not a startup percentile. All portable controls and raw call samples
remain in the reports and `comparison.json`; the tables below compare AOT.

| AOT result                     | TypeScript, host dates | Rust, host dates | Rust, guest-local dates |
| ------------------------------ | ---------------------: | ---------------: | ----------------------: |
| Native ordinary render p95     |               0.579 ms |         0.064 ms |                0.059 ms |
| Native date-heavy p95          |               2.367 ms |         0.538 ms |                0.387 ms |
| Pulley ordinary render p95     |               4.577 ms |         0.292 ms |                0.361 ms |
| Pulley date-heavy p95          |              38.852 ms |         1.496 ms |               11.152 ms |
| Native cold render preparation |              60.778 ms |        16.448 ms |               18.706 ms |
| Pulley cold render preparation |              56.330 ms |         8.703 ms |               22.297 ms |

| Size/memory                             |  TypeScript | Rust, host dates | Rust, guest-local dates |
| --------------------------------------- | ----------: | ---------------: | ----------------------: |
| Portable component                      | 1,727,495 B |        121,628 B |             1,046,912 B |
| Android native AOT gzip                 | 1,706,139 B |        146,172 B |               292,978 B |
| Render guest linear memory              |   1.438 MiB |        1.125 MiB |               1.938 MiB |
| Menu guest linear memory                |   1.750 MiB |        2.000 MiB |               2.812 MiB |
| Native AOT process peak after all cases |  16.121 MiB |        8.730 MiB |               9.590 MiB |

Moving calendar work into the guest improved the native date-heavy case by
about 28%, saving about 0.15 ms. The ordinary native difference was about
0.006 ms, too small to justify a broad speed claim from this sequential run.
Pulley's date-heavy total became about 7.5 times slower. Host functions execute
as native Rust even when the guest is interpreted; avoiding the Wasm boundary
then trades native work for interpreted guest instructions. These calls are
in-process Wasmtime imports, not Tauri/WebView IPC.

The local candidate adds 925,284 portable bytes, 146,806 native AOT gzip bytes,
and 0.8125 MiB guest linear memory in both render and menu. Those gzip sizes
are artifacts, not measured APK deltas. Process RSS includes code, data and
compiler/allocator state and is distinct from guest linear memory. Each call
still uses a fresh instance. Large warm-total differences between portable
and AOT runs do not isolate an AOT effect on guest execution; source selection
primarily changes cold preparation, and per-call instantiation/memory and CPU
state also contribute. The raw distributions separate these phases.

The measured tradeoff favors retaining the host-backed Rust candidate for the
shared native/interpreter plugin. Keep this local candidate available for
comparison. A native-only date-intensive workload could make a different
choice, but reducing interface calls alone is not a sufficient optimization
criterion. A batched host calendar operation would be a separate experiment;
this change does not expand or remove the production Host API.

Whole-app startup, APK size and app memory were not remeasured with this
candidate. The earlier [whole-app measurements](../wasm-optimization-2026-10-21/README.md)
still apply only to the shipped TypeScript portable/AOT builds. Existing M5
release gates, including interpreter budget reliability and broader retention,
remain open. The guest-local fixture reaches 2.8125 MiB linear memory in the
menu; it does not by itself justify the 32 MiB default cap.

## Reproduction

Build both guest variants with Node 22:

```text
node plugin-sdk/prototypes/templates-rust/build.mjs
node plugin-sdk/prototypes/templates-rust/build.mjs --local-calendar
```

Stage each component in its own directory with a compiler-only manifest
containing `id`, `runtime: "wasm"` and `entry: "plugin.wasm"`. Generate trusted
artifacts for `aarch64-linux-android` and `pulley64` using the
`plugin-precompile` example as in the earlier optimization procedure. Combine
the two `precompiled.rs` arrays and point `MINDSTREAM_PROBE_PRECOMPILED` at the
absolute combined file. Configure the documented NDK/API26 linker and build:

```text
cargo build --manifest-path src-tauri/Cargo.toml --locked --release --target aarch64-linux-android -p mindstream-plugin-runtime --features probe-precompiled --example plugin-bench
```

`run.ps1` executes all twelve combinations on the named physical device. It
requires the recorded Europe/Berlin timezone; it does not modify device time or
power settings. Adapt and validate timezone parity before using another zone.
The test app is stopped during probes and reopened afterward without changing
its installed package or data. `summarize.py` recreates the validated comparison.
`SHA256SUMS` covers this folder except itself. JSON is pretty-printed without
changing values; raw logs and JSONL are preserved. Production plugin selection
and Luau availability are unchanged.
