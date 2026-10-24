# Non-shipped plugin examples

This directory is outside the app's embedded `plugins/` tree. None of these
packages or their JavaScript runtimes are bundled into the app. The Rust
sources for shipped plugins are in [bundled](../bundled/README.md).

- `templates-typescript/` implements template menus and placeholders with the
  TypeScript SDK. Its settings and toolbar work like the shipped Rust plugin.
- `typst-typescript/` demonstrates optional declared native tools, binary
  output, diagnostics and source-only fallback.
- `legacy-luau/` retains pre-migration sources and host annotations for parity
  tests and migration comparisons. These are regression fixtures, not current
  installable example packages.

The TypeScript examples have distinct `com.example.*.typescript` IDs so they
can be installed without replacing trusted first-party packages. Each folder
contains its manifest, assets and source. The built `plugin.wasm` is not
committed. Build it with Node >=22.11, without a Rust compiler:

```sh
pnpm install --frozen-lockfile
pnpm plugins:examples
```

Install the example folder through Settings → Plugins and approve its grants.
For Templates, set a template folder or tag in that example's settings, then
use its toolbar contribution. These packages still use QuickJS inside their
components. The shared Wasmtime host does not impose that runtime on Rust
plugins. Tests exercise the same outputs and native-tool protocol for both
languages.

The interface is defined by [WIT](../wit/world.wit), not TypeScript. Another
language needs component bindings for that contract, a matching `invoke`
export and the JSON/effect protocol. A core Wasm module, a WASI command or a
module expecting browser/Node imports cannot be installed unchanged. The
current host only supplies the versioned `mindstream:plugin` interfaces;
Rust and TypeScript are the tested authoring paths.

[`ts-rust`](https://github.com/pingdotgg/ts-rust) implements the TypeScript
compiler/checker in Rust. Its [Wasm build](https://github.com/pingdotgg/ts-rust/blob/main/npm/wasm/README.md)
runs that compiler in Wasm and still emits JavaScript. It does not turn a
TypeScript plugin into compiled Rust/Wasm guest logic, so it does not remove
QuickJS from this SDK's TypeScript components.
