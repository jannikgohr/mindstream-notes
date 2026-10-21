# Shipped Rust plugin validation

Executable first-party plugins now use Rust at `8fa0b109`. Templates and Typst
keep their existing manifests, contribution IDs, permissions and effect shapes.
LanguageTool remains manifest-only. TypeScript packages have distinct example
IDs under `plugin-sdk/examples/`, outside the embedded `plugins/` tree. Luau
sources moved there as regression fixtures; its adapter and v1 support remain.

## Protocol and artifacts

Physical Samsung SM-T733, ARM64 SM7325, Android 14/API34, Europe/Berlin, serial
`R52W103DQPB`. Eight release probe processes compare Rust/TypeScript, native/
Pulley and portable/trusted AOT loading. Each of five workloads uses 100 warm
samples at the unchanged 1,000 ms budget. All 4,000 samples completed without
overruns, all exit codes were zero and corresponding outputs matched. Dedicated
cancellation/memory controls keep their existing separate protocol and limits.
`summarize.py` validates the raw reports and recreates `comparison.json`.

The tablet was USB charging, battery saver off and thermal status 0 throughout.
Battery was 41-42%, with reported battery temperatures 29.8-29.9 C. The operator
previously reported normal temperatures. Ambient temperature, case and external
cooling remain unobserved. The app/screen state was not controlled or changed
for this standalone probe. Order was fixed, Rust before TypeScript in each
pair; there is one process observation per combination, without randomized
ordering or confidence intervals. Windows compilation ran on the host, not
the tablet. These results do not establish performance across thermal states.

Rust 1.97.1, Wasmtime 49.0.4, Node 22.21.1, NDK 29.0.14206865 and API26 ARM64
clang. The host is Windows 11 on Ryzen 7800X3D. Exact versions, device fingerprint
and host OS build are in `logs/toolchain.txt.gz`. The Rust guest workspace pins
its toolchain/lockfile. `artifacts.json` hashes the components, device test
executable, probe and trusted precompiler. The two precompiled manifests record
the exact source/compiled hashes, target and compressed artifact sizes.
`run-status.json` retains args, timestamps and the probe hash. Run
[run-comparison.ps1](run-comparison.ps1) after building the release probe with
the matching trusted native/Pulley tables, using the migration procedure.
Raw stdout includes adb transfer output; it is retained without editing.

## Measurements

The table reports per-process p95 preparation + fresh instantiation + guest call,
including host imports. It excludes WebView/IPC and whole-app startup.

| Trusted AOT case                 |  Rust p95 | TypeScript p95 |
| -------------------------------- | --------: | -------------: |
| Native Templates render          |  0.054 ms |       0.565 ms |
| Native Templates menu, 500 notes |  2.684 ms |      25.687 ms |
| Native Typst source-only         |  0.038 ms |       0.362 ms |
| Pulley Templates render          |  0.288 ms |       4.557 ms |
| Pulley Templates menu, 500 notes | 51.267 ms |     804.488 ms |
| Pulley Typst source-only         |  0.111 ms |       1.367 ms |

Native cold render preparation was 5.761 ms Rust versus 58.505 ms TypeScript
with trusted AOT, and 76.547 versus 961.476 ms with portable compilation.
Native Typst cold preparation was 4.782 versus 45.526 ms with AOT, and
52.569 versus 712.900 ms portable. Cold preparation is a single observation,
not startup p95. The raw reports distinguish compilation/loading, instantiation,
guest execution, disk-cache load and warm calls. They supersede no historical
measurements; earlier reports retain their original artifacts and conditions.

| Portable component / guest memory     |      Rust | TypeScript example |
| ------------------------------------- | --------: | -----------------: |
| Templates component                   | 121,114 B |        1,739,940 B |
| Typst component                       |  75,297 B |        1,165,832 B |
| Templates render linear memory        | 1.125 MiB |          1.438 MiB |
| Templates 500-note menu linear memory | 2.000 MiB |          1.750 MiB |
| Typst source-only linear memory       | 1.125 MiB |          1.438 MiB |

The previously shipped components at `3eeab5b3` were 1,727,495 and 1,152,973 B;
the new portable pair saves 2,684,057 B against those exact bytes. The rebuilt
TypeScript examples above use the current SDK/WIT and have their own hashes.
Rust removes the embedded QuickJS runtime from first-party components, but
does not reduce every workload's heap use. The Rust menu uses more linear
memory. The default 32 MiB cap is unchanged.

Native AOT process RSS after 100 menu calls was 11,084 KiB Rust versus
17,160 KiB TypeScript. Reports also retain RSS/HWM/PSS before compilation,
after cold calls and after 1/10/50/100 warm calls. These are complete probe
processes with conformance fixtures and earlier case activity, not isolated
plugin allocations or installed-app memory. One hundred calls do not establish
long-term retention. Matching app startup, memory, APK/AAB/installer and macOS
bundle measurements must still be repeated for this revision.

## Correctness and CI

Windows workspace: 1,038 app tests passed, six ignored; integration suites
passed with one ignored case; 83 runtime tests passed. Final physical ARM64
release runtime: 88 passed, including native/Pulley parity and source-only
Typst fallback. A final Windows check against the remapped artifacts passed
200 app plugin tests with one ignored and all 83 runtime tests. Three Rust
guest unit tests passed. SDK/bundled checks passed
34 tests, and the full frontend/SDK run passed 3,590 tests in 301 files. Svelte
check had zero errors/warnings. Workspace and guest clippy with warnings denied,
Rustfmt, SDK typecheck and the packed Node-only authoring check passed.
The final global ESLint run passed with zero errors and 178 existing warnings.

An intermediate `pnpm run test:plugin-author` invocation was rejected by that
check's npm-launcher guard. The documented `npm run test:plugin-author` passed
under Node 22 without Cargo/rustc. Its rejected and passing logs are retained.
The pre-remapping Android run also passed 88 tests; its log is labeled
`before-remap`. Final device evidence uses the remapped component hashes.

The first [CI run](https://github.com/jannikgohr/mindstream-notes/actions/runs/39620941825)
at `8fa0b109` passed all three portable runtime jobs. The shipped 500-note menu
p95 totals were:

| CI runner      |   Native |    Pulley |
| -------------- | -------: | --------: |
| macOS ARM64    | 1.381 ms | 27.057 ms |
| Windows x86_64 | 2.194 ms | 30.399 ms |
| Linux x86_64   | 1.572 ms | 22.679 ms |

Each report used 100 samples, the default budget and the committed Rust
Templates bytes. No timed cases overran. Reports for the retained Rust prototype
are also archived separately. This is new runtime evidence for the shipped Rust
selection; it does not erase the older TypeScript/macOS failure or establish
macOS installed-app behavior. Runner power/thermals were uncontrolled.

That first workflow did not pass overall. Global ESLint found unused variables
in immutable historical browser-console snippets. They are now excluded from
app lint, preserving the old evidence hashes. The new guest job compiled,
passed clippy/tests/package preflight, but failed strict cross-host byte
comparison: Linux produced 121,259/75,442 B versus Windows 121,114/75,297 B.
Source paths were normalized; cross-host byte identity remains unproven.
No semantic equivalence is inferred from that failed comparison alone.
That first job did not retain complete hashes/bytes of its rebuilt artifacts;
the later jobs now upload both.

`7cc8e9fa` changes CI to test both committed and freshly rebuilt guests against
the same behavior assertions and retain the rebuilt bytes/hashes. The
[replacement run](https://github.com/jannikgohr/mindstream-notes/actions/runs/39622425773)
passed formatting/lint, but its guest behavior step failed before running any
assertions because SvelteKit's generated test configuration was missing.
`3c2a8c46` switches that step to the root test command, which runs SvelteKit sync
first. The exact Linux-built components were downloaded, hashed and passed all
11 shared package/behavior assertions locally, including the TypeScript
controls. Their compressed bytes and the passing log are retained. This is
functional parity evidence, not byte identity.

The [third run](https://github.com/jannikgohr/mindstream-notes/actions/runs/39624455858)
passed the rebuilt-guest job, including Rustfmt, clippy, three Rust tests,
package preflight and all 11 shared behavior assertions. Its rebuilt Linux
components match the preceding Linux rebuild hashes. Its instrumented Linux
coverage job failed the interpreter conformance test with `Budget`, with 87
runtime tests passed and one failed. The coverage launcher still used parallel
tests, unlike the functional Rust job. `c7e51b93` sets `RUST_TEST_THREADS=1` for
coverage too. It changes no timeout, memory cap, coverage threshold or test
selection. The failure remains in `logs/ci-coverage-failed.txt.gz`; serialization
has not yet been shown to resolve that instrumented failure.

The [coverage-fix run](https://github.com/jannikgohr/mindstream-notes/actions/runs/39627105159)
is tracked in `ci-status.json`; no pending job is counted as passed. Separate
snapshots preserve the first three workflows. Superseded workflows were cancelled
after preserving their completed reports/failures. Failure logs are in
`logs/ci-*-failed.txt.gz`.

## Release decision

First-party Rust ports are selected and tested; the interface remains private
and language agnostic. Rust/TypeScript are the tested authoring paths. Other
languages need matching component bindings, imports and JSON/effect behavior.
`ts-rust` still emits JavaScript and does not remove QuickJS from this SDK's
TypeScript path; the [example guide](../../../plugin-sdk/examples/README.md)
links the upstream explanation.

This report does not install a new app or claim current whole-app size/startup,
memory retention, every ABI, broader physical-device conditions or immediate
background cancellation. M5/M6 remain open. Retain Luau until the remaining
release gates and outstanding CI checks pass. No budget was raised and no
untested platform is passed.
