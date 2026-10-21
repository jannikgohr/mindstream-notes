# Batch recovery validation

This update follows `ba8f1e1b`. The experimental batch failure record now
reports the stopping command index, validation/execution/result-limit phase,
successful prefix handler count, accepted kept replies and original cause.
The [contract](../../plugin-host-api-design.md#recovering-after-a-batch-error)
defines partial effects, rejected results, backward references and fatal traps.
The private ABI changed; batch guests must be rebuilt with the matching host.
All three Rust comparison components were rebuilt. Shipped Templates and Luau
remain unchanged.

## Checks

- Windows debug runtime: 82 passed, serial execution, default budgets.
- Physical ARM64 Android release runtime: 87 passed, serial execution through
  `plugin-sdk/android-runner.mjs`, default budgets. The larger count includes
  Unix-only host/path tests. The compiled Rust batch guest regression runs
  through native Wasmtime and Pulley, checks the failure index/phase/count,
  kept reply indices/values and the earlier storage write. Executor tests cover
  validation before effects, execution errors, rejected oversized results and
  fatal cancellation/deadline behavior.
- Node 22.21.1 frontend/SDK: 3,585 tests passed in 301 files; the separate
  SDK/bundled suite passed 29 tests in five files. Compiled QuickJS guest tests
  check validation/execution progress and earlier storage effects. The mock
  also checks result-limit progress and omission of the oversized output.
- Svelte check: zero errors/warnings. SDK typecheck, scoped ESLint, runtime
  all-target clippy, guest batch/local-calendar clippy and Rustfmt passed.
  Guest calendar tests: seven passed.

An extra SDK-only rerun launched child processes under the default Node
20.19.6 and failed 15 tests with `opcode i32.add is not allowed in constant
expressions`. It is retained in `logs/sdk-tests-wrong-node.txt.gz`; the SDK
requires Node >=22.11.0. Setting both the launcher and child-process PATH to
Node 22.21.1 passed. The full frontend run also used that PATH and passed.
No budgets were increased.

## Device and artifacts

Physical Samsung SM-T733, serial `R52W103DQPB`, ARM64 SM7325,
Android 14/API34. Fingerprint:
`samsung/gts7fewifieea/gts7fewifi:14/UP1A.231005.007/T733XXS9DYF1:user/release-keys`.
USB charging, battery saver off, 34% battery before/after, battery temperature
31.0 to 31.1 C, thermal status 0 before/after. Reported AP temperature changed
from 32.0 to 33.7 C. The operator previously reported normal temperatures;
ambient temperature, case and external cooling remain unobserved. No app,
power-mode or screen settings were changed for this functional test run.

Windows 11/Ryzen 7800X3D, Rust 1.97.1, Wasmtime 49.0.4, Android NDK
29.0.14206865, API26 ARM64 clang and Node 22.21.1. Exact compiler/adb details
are in `logs/toolchain.txt.gz`. The Android run finished at
2026-10-21T12:45:31Z with exit code zero. `android-run.json` and `artifacts.json`
record the runtime test executable and component hashes. Raw test/build and
device-state logs are gzip-compressed without editing. `SHA256SUMS` covers the
files in this evidence directory. Run [run-android.ps1](run-android.ps1) from
the repository root to reproduce the device test with SDK/NDK installed.

## Remaining gates

This is correctness evidence, with no new performance, process memory,
startup, package-size or installed-app UI measurements. The earlier
[batch timing report](../wasm-host-batch-2026-10-21/README.md) describes its
original artifacts and failure contract. Its hashes and raw measurements are
unchanged. The current design guide explains why that batch implementation
could lose despite fewer imports; no isolated cost profile is claimed.
macOS/Windows CI for this revision remains separate evidence. M5/M6 and the
matching-build release gates remain open; retain Luau.
