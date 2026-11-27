# Build performance

How the native build is set up to stay fast, the traps behind those settings,
and where the remaining time goes.

## Development builds

`pnpm tauri-dev` starts Vite through `pnpm dev:native`, then runs Cargo with
`dev-environment` and the development app configuration. It does not run
`pnpm plugins:build`, `plugin-sdk/fixtures.mjs` or the browser Wasm build. The
core plugins' `plugin.wasm` files (graph, journal, templates, typst) are
committed.

- **No host compiler in development.** The Wasmtime compiler that precompiles
  the core plugins is an optional build dependency behind the default
  `bundled-aot` feature. The development launcher
  ([`tauri.mjs`](../../src-tauri/scripts/tauri.mjs)) passes
  `--no-default-features` and enables `dev-environment` itself. Pass
  `--features bundled-aot` to get the compiler back.
- **`--no-default-features` goes after Tauri's first `--`.** It is a Cargo
  runner argument; anywhere else Tauri re-enables the manifest defaults.
- **A release build without `bundled-aot` warns.** Set
  `MINDSTREAM_BUNDLED_AOT=0` to acknowledge that the plugins will compile at
  runtime instead.
- **Tauri's context is generated in `build.rs`** with
  `tauri_build::CodegenContext` and included with `tauri_build_context!`.
  Generating it inside the app crate wrote an icon into `OUT_DIR` during
  compilation and forced one extra app rebuild on the next run.
- **`frontendDist` is left out of the context when a dev server is used**, so
  rebuilding `.output/build` doesn't recompile the development backend.
- **Dependencies keep limited debug information** (`profile.dev.package."*"`,
  `debug = 1`). Workspace code keeps full information, and
  `pulley-interpreter` stays at `opt-level = 2` so plugin deadlines hold in debug
  builds.
- **Linux uses unpacked split debug information.** The launcher sets
  `CARGO_PROFILE_DEV_SPLIT_DEBUGINFO=unpacked` unless it is already set, a
  target is given, or a Cargo profile override exists. Keep the `.dwo` files next
  to the build output for debugging. Opt out with
  `CARGO_PROFILE_DEV_SPLIT_DEBUGINFO=off pnpm tauri-dev`.

Changing `TAURI_CONFIG` reruns the app build script. Changing features,
build/check/test mode, Rust flags, target or toolchain can select different
dependency artifacts, and every worktree starts with its own `src-tauri/target`.
To find out why something rebuilt, keep the command unchanged and run:

```sh
CARGO_LOG=cargo::core::compiler::fingerprint=info pnpm tauri-dev
```

The plugin runtime's own Wasmtime cache under the data root's
`plugin-cache/wasm` is a separate thing: it compiles plugins at startup when
the engine hash or data root changes, and has nothing to do with Cargo.

## CI

- **The `Build performance` workflow**
  ([`build-performance.yml`](../../.github/workflows/build-performance.yml))
  builds the development backend twice and fails if the second build has any
  artifact that isn't fresh, checked by `scripts/check-cargo-fresh.mjs`. It
  checks reuse rather than elapsed time, because the first repeat can still
  spend a few seconds on filesystem work. A manual run with `cold` skips the
  Rust cache.
- **The packaged E2E build uses a cheaper release profile**: LTO off, 16
  codegen units, `opt-level = 2`, set in
  [`build-profile.ts`](../../e2e-tests/app/helpers/build-profile.ts). It keeps
  release mode, production assets and bundled plugin AOT, so it can miss bugs
  that only show with the shipped size-optimised profile. Set
  `MINDSTREAM_E2E_PRODUCTION_PROFILE=1` to test with the shipped profile before a
  release.
- **`rust-cache` ignores `key` when `shared-key` is set.** The E2E job puts the
  hash of `build-profile.ts` into `shared-key`; otherwise it restores a cache
  built with the wrong profile and rebuilds every dependency.
- **Plugin fixture caches.** Rust guest fixtures have their own CI cache, keyed
  by exact sources, so a fixture change starts cold. TypeScript fixture
  components are cached by source, WIT, SDK, recipe, lockfile, Node version and
  platform. Set `MINDSTREAM_PLUGIN_FIXTURE_CACHE=0` to force fresh builds.
- **Timing artifacts.** The native test jobs, the packaged E2E build and the
  performance workflow attach Cargo timing reports and `build-timings.json`,
  which separates plugin precompilation from context generation.

## Open leads

- **Release jobs use floating stable Rust** (`dtolnay/rust-toolchain@stable` in
  [`release.yml`](../../.github/workflows/release.yml)). The cache key includes
  the compiler version, so every Rust point release misses the cache. Pinning
  the toolchain would make release builds more predictable.
- **Android recompiles the app several times.** The release job builds an APK
  and an AAB for four ABIs. The October 2026 release log showed eight Cargo
  passes, several of them rebuilding only the app for about two minutes each.
  The logs never showed why; check the fingerprint log before dropping ABIs.
- **macOS builds both architectures one after the other** for the universal
  binary, about 15 minutes each. Separate jobs would cut elapsed time, not
  compute.
- **`pnpm tauri android dev` still builds the host compiler.** The launcher
  only drops it for `tauri dev`.
