# Rust plugin starter

Rust is the authoring path used by [shipped executable plugins](../bundled/README.md).
TypeScript authors can use the [Node-only SDK](../typescript/README.md) and
[non-shipped examples](../examples/README.md).

From the repository root:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-tools --locked
node plugin-sdk/rust/create.mjs /tmp/rust-hello
cd /tmp/rust-hello
node build.mjs
```

Choose an appropriate absolute project path on Windows. Install `dist` from
Settings → Plugins. It contains the manifest, toolbar icon and component.
Change the manifest's ID before distributing your plugin, and sign the `dist`
folder so later versions update without a new approval; see
[Signing](../../docs/plugins.md#signing-third-party-plugins). Keep the
generated `Cargo.lock` in your project to pin dependency versions.

`wit-bindgen` generates Rust imports and the `Guest` trait from the copied
`wit` directory. Implement `invoke(export, input)` with JSON strings and use
`export!` to expose it. A successful call returns serialized JSON. A failed
call returns an error string. Effects are data for the app to validate and
apply. This starter also implements the SDK's `$exports` probe for preflight.

The build targets `wasm32-unknown-unknown`, then wraps the core module as a
component with `wasm-tools component new`. Do not add WASI or filesystem/network
imports. The host supplies only the versioned `mindstream:plugin` interfaces.
The finished component is portable across desktop and Android; only the host
runtime is built for each CPU.

The [conformance fixture](../conformance/rust/src/lib.rs) demonstrates every
host capability, permission errors and native tools. Every invocation gets a
fresh instance, so store persistent state through the host storage API.
