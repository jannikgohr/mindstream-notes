# Plugin host internals

How the plugin host stores, verifies and runs plugins, and how the core
plugins and the TypeScript SDK are maintained. The contract plugin authors work
against is in [Writing plugins](../plugin-development.md); what people see is
in [Plugins](../plugins.md). The proposals for new host capabilities are in the
[host API design](plugin-host-api-design.md).

The contribution and permission types are in
[`src/lib/plugins/types.ts`](../../src/lib/plugins/types.ts); the Rust side is
under [`src-tauri/src/plugins/`](../../src-tauri/src/plugins/mod.rs).

## Where plugins live

| Kind                  | Location                                                                  | Trust                                                           |
| --------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Core (bundled)        | repo-root `plugins/<name>/` → embedded in the app binary (`include_dir!`) | `builtin` — trusted by location, ships inside the signed binary |
| Third-party (install) | `<root>/plugin-packages/<digest>/` via the root catalog                   | `installed` — subject to the integrity gate                     |

Core plugins are trusted because their bytes are embedded in the signed binary.
Installed packages are always third-party, regardless of manifest fields, and a
third-party package cannot replace or inherit trust from a builtin ID.

The root catalog is `plugins/catalog.json`. Packages are immutable, addressed by
all package bytes, including signature metadata. Downloads use
`plugin-artifacts/<plugin>/<artifact>/<version>/<sha256>/<filename>` so two builds
with the same declared version cannot overwrite each other. Scripts and preview
services receive effective settings from the backend. Settings with `scope: "D"`
are shared in root `plugin-settings.json`; `scope: "V"` stays in the vault
database. Writable `plugin-data/<plugin>` always stays inside its vault.

Removal keeps settings, approval records and writable plugin data. Running tasks
keep their old package files until they finish; new calls cannot use a removed
package. Missing packages remain visible in the management list with a disabled
state.

## Migration from per-vault plugin folders

Migration prefers an existing valid root package, then the startup-selected
vault, then other vaults. Identical packages deduplicate. Original vault plugin
folders, settings rows and conflicting files remain intact as migration
evidence; receipts prevent them from reversing a later removal or reset. Root
`plugins/<name>/` folders can also serve as package input. Folder selection is
the explicit way to reinstall unchanged bytes after removal.

## Permissions and contribution points

A manifest is rejected if it contributes something it didn't ask permission
for. That rule lives in one table, `CONTRIBUTION_POINTS` in
`src/lib/plugins/types.ts`, read by both the validator and the contribution
registry, so what is checked and what is enforced cannot drift apart.

The permission list used to be longer. It carried _contribution gates_
(`templates.contribute`, `noteKinds.contribute`, `noteExporters.contribute`),
which only restated what `contributes` already said and gated nothing at
runtime, and `pluginWebviews.allowEval`, which is a CSP setting on one
contribution rather than a resource anyone can reach. Those are gone;
`webview.allowEval` is now just the manifest flag it always was.

Same-signer updates keep their approval only when they request no added
permissions (`widens` in `src-tauri/src/plugins/mod.rs`). Every command that runs
plugin code re-reads the plugin from disk and compares its digest to the
approved one first.

## The runtime

A shared Wasmtime engine caches compiled components. Every invocation uses a
fresh store and instance. The runtime starts on first use, so plugin discovery
does not initialise guests. Discovery rejects a Wasm package whose declared
entry is missing. Each execution uses the entry bytes captured during package
verification, including for embedded plugins; it never reopens the entry to
fill a missing snapshot. The compiled cache holds at most eight components in
memory and 32 on disk per engine compatibility key.

Epoch checks interrupt loops and cancellation. The host-call transfer budget is
enforced by Wasmtime while it lifts arguments, before the host handler receives
owned strings and lists, which is what stops repeated references to one guest
string from causing large host allocations before validation. The runtime
allows up to 128 MiB of encoded result copying to accommodate UTF-16, then
checks the decoded UTF-8 length against the 64 MiB result limit.

Resource interruption, cancellation and process behaviour are covered by the
Rust runtime suite rather than the SDK's test harness.

## Design notes

**The context object.** Anything the backend can determine for itself, it
does, and its values win on a collision, so a caller cannot tell a script it
has settings it does not have, or hand it a false clock. It also means the
backend has everything it needs to invoke a plugin without a UI action behind
it, which a future event or watcher would require. Only the two window-scoped
fields (`activeNoteId`, `locale`) come from the frontend.

**Reserved namespaces.** The ABI reserves future `mindstream:ai` and
`mindstream:ocr` capability namespaces. They are design boundaries only. A
future host API should use opaque model and attachment IDs, explicit grants and
cancellable asynchronous jobs.

**Why the host makes text-checker requests.** Besides keeping note text away
from plugin code, it is the only way the request works at all. A self-hosted
server sends no CORS headers, so a WebView `fetch` to the usual setup is refused
before it leaves; Chromium gates page-to-LAN requests through Private Network
Access; and where the app is served from a custom scheme treated as secure, a
plain-`http://` server is blocked as mixed content. `reqwest` in the backend is
subject to none of the three.

**Why the text-checker protocol is declarative.** It replaced a host-owned list
of supported protocols that had exactly one entry, which meant a second service
required an app change and a third-party plugin could not add one at all. JSON
Pointers rather than a query language: they are a standard, they cannot loop or
backtrack, and they resolve natively in the backend. A detection naming a
language the user writes is taken at its word however sure the service sounds:
a short fragment scores low whether the guess is right or wrong, so a score
floor threw away correct answers to catch wrong ones the language test already
catches.

**Why grammar patterns run in a Worker.** It is the same bargain scripted
plugins get from `limits.timeoutMs`: a plugin fault costs the plugin, not the
app. No static check reliably separates a regex that backtracks
catastrophically from one that does not (star-height tests miss `(a|ab)*`), and
a single match cannot be interrupted once started, so terminating the Worker is
the only thing that actually stops one. A faulted grammar stays faulted for the
session because asking again on the next keystroke would freeze again. There is
no inline fallback where no Worker exists, since that would quietly discard the
guarantee. Delimiter limits keep the per-character cost flat, and `indentation`
is filtered by position rather than by the checker's message, which arrives
already localised and so cannot be matched against.

## Core plugins

The core packages ship from repo-root `plugins/`; executable source is under
[`plugin-sdk/bundled/`](../../plugin-sdk/bundled/README.md). Each documents
itself in the app through its manifest's `descriptionKey` and `documentation`.

- **Templates** (`com.mindstream.templates.core`) is a compiled Rust component.
  `newFromTemplate` lists notes of any kind matching the configured folder or
  tag and returns a menu of `createNoteFromNote` effects. `renderTemplate`
  expands the selected note's title and body. The macro engine belongs to the
  plugin; the app validates and performs the write.
- **Typst** (`com.mindstream.typst`) renders and exports through the declared
  native `typst` tool. Its settings, source language, toolbar items and the
  `tinymist` preview service are declarative.
- **LanguageTool** (`com.mindstream.languagetool`) is manifest-only.

Rebuild both committed components with `pnpm plugins:build`, using the pinned
Rust toolchain and Node 22.11 or later. Core components contain no QuickJS
runtime, and the app needs no Node or Rust guest compiler at runtime.

## Testing

Run `npm run test:plugin-author` in the repository to check the packed SDK in
an isolated directory without Cargo or rustc. `pnpm test` includes the SDK and
core-component behaviour tests. `pnpm plugins:build` rebuilds the core
components' bytes.

## Maintaining the TypeScript SDK

Run `pnpm --filter @mindstream/plugin-sdk generate:types` after changing WIT.
The generator uses jco's guest bindings and adapts options and 64-bit integers
to QuickJS conventions. Tests compare the complete declarations against WIT,
including record fields and signatures. Plugin authors use the packed
declarations without generating or editing them.

TypeScript components carry QuickJS, and nothing on the horizon removes it.
[`ts-rust`](https://github.com/pingdotgg/ts-rust) implements the TypeScript
compiler and checker in Rust, and its
[Wasm build](https://github.com/pingdotgg/ts-rust/blob/main/npm/wasm/README.md)
runs that compiler in Wasm, but it still emits JavaScript. It does not turn a
TypeScript plugin into compiled Rust/Wasm guest logic.
