# Rust Templates comparison

This prototype implements the current TypeScript Templates exports against the
same WIT and host APIs. It is not the shipped plugin. Luau and the TypeScript
package remain in place while release gates are open.

Build with Rust's `wasm32-unknown-unknown` target, the repository's installed
Node 22 dependencies, and `node plugin-sdk/prototypes/templates-rust/build.mjs`.
The lockfile and component are committed so runtime tests need no guest compiler.

`rust_templates_prototype_matches_typescript_outputs` compares rendering,
calendar offsets, filters, Unicode menu order, stable equal-label order,
folder ancestry/cycles and tag selection. Debug tests use the native runtime
and 50 notes. Release tests also cover Pulley. Neither changes the one-second
budget. The release `plugin-bench --templates-only --rust-templates` probe uses
500 notes and defaults to 100 samples. Run a separate process without
`--rust-templates` for the matching TypeScript comparison.

The prototype shares the host calendar and notes API. Its size and linear
memory differences measure guest implementation costs; they do not replace
whole-app process memory measurements. These fixtures do not establish parity
for every malformed input or unusual JavaScript coercion.
