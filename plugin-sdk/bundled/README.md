# Shipped Rust plugins

Templates and Typst are compiled Rust components. Installable packages are in
the repository's `plugins/` directory, which the app embeds. This workspace
contains their source and lockfile; it does not embed a JavaScript engine.
LanguageTool remains a manifest-only plugin.

Build from the repository root with Node >=22.11 and Rustup installed:

```sh
pnpm install --frozen-lockfile
pnpm plugins:build
```

The build uses the pinned toolchain in `rust-toolchain.toml`, compiles
`wasm32-unknown-unknown`, wraps the modules as components and runs package
preflight. A first pass discovers surviving Rust panic source paths; a second
pass remaps complete filenames to stable `/mindstream/` paths, including
Windows separators. The lockfile and generated `plugins/*/plugin.wasm` are committed.
CI rebuilds them with the same toolchain and rejects byte differences.
An ordinary app build uses those committed components; it does not need the
guest compiler or Node at runtime.

Run Rustfmt, clippy with warnings denied and tests from this directory:

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
```

The SDK's bundled tests run the same behavior assertions against the shipped
Rust components and the [non-shipped TypeScript examples](../examples/README.md).
App-host tests also compare Templates with retained Luau. Runtime tests cover
the compiled components on native Wasmtime and the Pulley interpreter.

Templates keeps the measured scalar host calendar path. The guest handles
placeholder parsing, variables, ASCII filters, folder/tag selection and menu
sorting. The host supplies local-time calendar semantics, UUIDs and authorized
note metadata. The experimental batch and guest-local calendar candidates
stay under `prototypes/`; they are not used by shipped Templates.

Typst builds arguments and groups diagnostics in the guest. The host checks
permissions and tool declarations, runs the optional desktop binary, handles
cancellation/time limits and returns encoded PDF output. Without that tool or
its permission, both render/export return source-only mode on every platform.

Switching first-party artifacts to Rust does not close the migration's
[release gates](../../docs/wasm-plugin-migration.md). Luau runtime support stays
until those gates pass.
