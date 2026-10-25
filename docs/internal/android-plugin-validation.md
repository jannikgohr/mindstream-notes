# Android plugin validation handoff

Validate the current Wasm-only plugin host on a physical Android device.
This work can run alongside Linux desktop validation for
[PR #115](https://github.com/jannikgohr/mindstream-notes/pull/115).

## Revision and scope

Fetch `origin/feat/wasm-plugin` into a separate checkout. The code revision to
include is `b453278b943758d3ffbe0f43a1e826d78b264a0b`, which aligns SDK and
frontend entry validation with the Rust host by rejecting any `..` in the
component entry. The handoff itself is a later documentation commit. Record
the exact tested SHA and artifact SHA-256 hashes in every result.

```sh
git fetch origin feat/wasm-plugin
git switch -c tests/android-plugin-validation origin/feat/wasm-plugin
git merge-base --is-ancestor b453278b943758d3ffbe0f43a1e826d78b264a0b HEAD
git rev-parse HEAD
pnpm install --frozen-lockfile
rustup target add wasm32-unknown-unknown aarch64-linux-android
```

Keep device test changes on that branch and return their commits for integration.
Do not push directly to `feat/wasm-plugin` while desktop work is in progress.
Use a disposable profile or app ID for lifecycle and cancellation tests.

Changes since the earlier device evidence include the 9 MiB host argument
transfer limit, verified-entry enforcement, the host batch API and recovery
record, Templates action visibility, Typst source/image exports, LanguageTool
manifest v2, source-built test fixtures, and complete Luau removal. Version 1
manifests and `runtime: "luau"` now fail validation intentionally.

The earlier physical device was a Samsung SM-T733, Android 14/API 34, ARM64.
Its results are historical context, not validation of this revision. The old
migration reports can be read with `git show 5b52c403:docs/wasm-plugin-migration.md`.
Their evidence links point to files archived outside this checkout.

## Environment and runtime checks

Use Node 22.11 or later, the repository's Rust toolchains, Android platform
tools, and an installed NDK. `libc` is locked at a version with the ARM64
signal-context fix; do not downgrade it. Tests build their components through
`src-tauri/plugin-fixtures` and `plugin-sdk/fixtures.mjs`, so Node, pnpm
dependencies and the Wasm Rust target must be available on the build machine.

Record the device model, SoC/ABIs, Android/WebView versions, OS build,
toolchains, battery charge, charging state, battery saver and thermal status.
Select the device with `ANDROID_SERIAL` if several are attached. On Linux,
configure the installed NDK, adjusting its path as needed:

```sh
export ANDROID_TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$ANDROID_TOOLCHAIN/aarch64-linux-android26-clang"
export CC_aarch64_linux_android="$ANDROID_TOOLCHAIN/aarch64-linux-android26-clang"
export AR_aarch64_linux_android="$ANDROID_TOOLCHAIN/llvm-ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUNNER="node $PWD/plugin-sdk/android-runner.mjs"
mkdir -p .output/android-plugin-validation

cargo test --manifest-path src-tauri/Cargo.toml --locked --release \
  --target aarch64-linux-android -p mindstream-plugin-runtime \
  -- --test-threads=1

cargo build --manifest-path src-tauri/Cargo.toml --locked --release \
  --target aarch64-linux-android -p mindstream-plugin-runtime --example plugin-bench
node plugin-sdk/android-runner.mjs \
  src-tauri/target/aarch64-linux-android/release/examples/plugin-bench \
  --iterations 100 > .output/android-plugin-validation/runtime-native.txt
node plugin-sdk/android-runner.mjs \
  src-tauri/target/aarch64-linux-android/release/examples/plugin-bench \
  --interpreter --iterations 100 > .output/android-plugin-validation/runtime-pulley.txt
```

Capture stderr and test output as well. Runner stdout contains adb transfer
messages and JSON, so retain the full transcript and extract the JSON separately.
The runner uploads only the executable into a unique scratch directory, sets
`TMPDIR`, and cleans that directory after exit. Components are embedded.

Run the default 1,000 ms workload budget unchanged. Record overruns and failed
attempts, even if a rerun passes. Check hostile batch lifting, maximum valid
scalar inputs, UTF-8/UTF-16 result limits, trap recovery, cancellation, storage
containment, permissions, batch progress, and Rust/TypeScript parity. Runtime
tests cover these; retain names and failure output. Debug timings do not count
as performance evidence. A Pulley run on ARM64 checks interpreter behavior,
but does not establish performance on a physical ARMv7 CPU.

## Installed application checks

Build a normal release APK and AAB with the normal frontend and trusted bundled
precompilation. Use the local Android SDK/NDK and signing setup, without putting
keys or passwords into reports:

```sh
pnpm tauri android build --target aarch64 --apk
pnpm tauri android build --target aarch64 --aab
```

Install the resulting APK on the selected device. Use a separate release build
with `--features tauri/devtools` if IPC inspection is needed. Label it separately
and use the normal build for size, startup and memory comparisons. Android's
UI currently hides folder installation; use the backend install/approval path
through a debugging session and report that distinction.

Use `e2e-tests/app/specs/single/plugins.e2e.ts` and
`e2e-tests/app/specs/single/plugin-lifecycle.e2e.ts` as the assertion reference.
These are desktop WebDriver suites, not an Android automation command. Build
their conformance component with `node plugin-sdk/fixtures.mjs`; use the same
signed plugin package across platforms where possible.

- Install, inspect, approve, enable and restart a signed package. Verify
  settings, note metadata access, isolated persistent storage and validated
  effects. A permission-changing update must need approval again.
- Configure a Templates folder/tag with real source notes. Check that its
  action is hidden before eligible sources exist, then creates a distinct
  note with substituted title/date. Preserve the source and test plugin-owned
  note kinds as templates.
- Enable Typst and LanguageTool. Check Typst source editing, persistence and
  `.typ` export without desktop binaries. Native compilation and services must
  report unavailable, with usable source editing. Check LanguageTool's v2
  declaration and its unavailable-service behavior.
- Start a runaway export and observe UI frames and another plugin's calls.
  Disable, remove and update/reapprove its package, then test recovery after
  re-enabling. Close/switch vaults and verify approval isolation.
- Background and resume the app during a runaway. Record whether it cancels
  immediately, stops at its deadline, or crashes. Earlier evidence only showed
  deadline termination, so do not claim immediate background cancellation.
- Reject missing entries, `plugin..wasm`, version 1 and Luau packages. Check
  that altered package bytes require approval and never replace an active
  call's verified snapshot with bytes reopened from disk.

## Measurements still due

Measure normal release builds under controlled, recorded device conditions.
Separate cold compilation, cache loading, instantiation, guest execution and
full application IPC timings. Discovery can prepare a component before the
first export; do not label that call cold compilation without checking.

1. Measure cold and warm startup to an interactive app, not just Activity first
   draw. Record the readiness action and sample count, with p50/p95/max.
2. Measure trivial cached calls and real Templates render/menu calls through
   app IPC. The historical render p95 was 11.4 ms against a target below 5 ms;
   standalone guest timing does not close the application-level gap.
3. Record guest linear memory separately from whole-app RSS/PSS and high-water
   memory. Take idle, post-compilation, repeated-call and post-idle checkpoints.
   Include at least 1,000 calls and a longer idle/repeated-use soak, stating the
   actual duration. Earlier 30-call app and 1,000-call runtime checks did not
   establish long-term retention behavior.
4. Compare APK, AAB, native library and delivered install sizes against a
   matching pre-migration build at `2bdba0b4`. Match frontend, profile, ABI,
   features, signing/packaging and shared startup fixes. Record any necessary
   baseline patches. The old stub-frontend binary is not a valid normal-app
   size baseline. The historical added-size target was 15,000,000 bytes.
5. Repeat representative workloads with stable charge/thermal state. Another
   physical device or ARMv7 CPU adds coverage; explicitly mark unavailable
   devices and ABIs as untested. The 32 MiB guest default also needs evidence
   from representative third-party workloads beyond the shipped guests.

Return exact commands, SHAs, hashes, device conditions, sample distributions,
raw logs, screenshots for visible assertions, and a pass/fail/unmeasured table.
Keep bulky evidence out of Git and provide its location plus checksums. Commit
small reports or test fixes on the separate test branch. Report failures without
raising production budgets or removing assertions to make the run pass.

## Recorded results

See the [24 October 2026 physical Android report](benchmarks/android-plugin-validation-2026-10-24.md)
for the tested revision, commands, artifacts, failures and remaining gates.
