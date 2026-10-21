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

## Guest-local calendar candidate

Build the second candidate with:

```text
node plugin-sdk/prototypes/templates-rust/build.mjs --local-calendar
```

This writes `plugin-local-calendar.wasm`; the default build still writes the
host-backed `plugin.wasm`. The feature is `local-calendar`. It moves date
arithmetic and the existing en/de moment-style formatter into the guest and
embeds chrono-tz's complete IANA database. It makes no `clock.add` or
`clock.format` calls. Notes metadata and UUIDs still use their existing host
capabilities. Both variants keep the same exports and effects.

Date rendering requires an extra `input.timeZone` containing an IANA name,
for example `Europe/Berlin`, alongside `input.now`. Missing or unknown zones
are errors, rather than silently using a fixed offset. A production integration
would need to supply that field, for example from the frontend's
`Intl.DateTimeFormat().resolvedOptions().timeZone`. This comparison candidate
is not a drop-in replacement for the current app context and is not installed
as the bundled Templates plugin.

The calendar algorithms and token tables in `src/calendar.rs` were copied
from `src-tauri/plugin-runtime/src/dates.rs` at `12937886`; future changes must
keep them aligned. Existing host semantics are preserved deliberately:
`+1d`/`+1w` add elapsed 24-hour periods, and month/year shifts into a skipped or
ambiguous local time keep the original timestamp. This experiment does not
change that policy. The guest embeds chrono-tz 0.10.4 / IANA 2025b, which can
differ from OS timezone updates; production acceptance needs a data-update
policy and broader zone coverage.

Run pure calendar tests with `cargo test --manifest-path
plugin-sdk/prototypes/templates-rust/Cargo.toml --locked --all-features`.
The runtime parity test compares all three components using the actual host
IANA zone. The physical Android comparison adds `--rust-local-calendar
--time-zone Europe/Berlin --calendar-heavy` to the release probe. See the
[measured comparison](../../../docs/benchmarks/wasm-local-calendar-2026-10-21/README.md).
