# Plugins

A plugin is a folder with a `manifest.json` and any referenced assets.
Manifest-only plugins contribute data. Executable plugins add a `.wasm`
component that runs in the Rust backend. The versioned WIT contract is
language agnostic; Rust and TypeScript are the tested build paths.
The host controls permissions, resource limits and effects.

All shipped plugins use manifest version 2. Templates and Typst execute as
Rust/Wasm components. LanguageTool uses the v2 declarative text-checker and
native-service contributions without an executable guest. Legacy Luau source
files live only in the non-shipped regression examples; runtime compatibility
remains until the migration's release gates pass.

Shipped executable plugins use Rust and generated WIT bindings. Start with the
[Rust authoring path](../plugin-sdk/rust/README.md), or use the
[TypeScript SDK and Node-only setup](../plugin-sdk/typescript/README.md).
[Non-shipped examples](../plugin-sdk/examples/README.md) include installable
TypeScript packages. A guest must implement the component world and JSON
protocol, not merely compile to a core Wasm module. WASI, browser and Node
imports are unavailable.
See the [migration gate report](wasm-plugin-migration.md) for platform evidence.
Luau remains temporarily available under manifest version 1 until the release
gates pass; its API is documented [separately](plugins-legacy-luau.md).

## Where plugins live

| Kind                    | Location                                                                  | Trust                                                           |
| ----------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| First-party (bundled)   | repo-root `plugins/<name>/` → embedded in the app binary (`include_dir!`) | `builtin` — trusted by location, ships inside the signed binary |
| Third-party (installed) | `<root>/plugin-packages/<digest>/` via the root catalog                   | `installed` — subject to the integrity gate below               |

Builtins are trusted because their bytes are embedded in the signed binary.
Installed packages are always third-party, regardless of manifest fields. A
third-party package cannot replace or inherit trust from a builtin ID.

Use Settings → Plugins → **Install or update from folder** to select a folder
containing `manifest.json`. Installation makes the package available to every
vault on this device. Each vault must approve it separately before it contributes
or executes. Enable/disable also applies only to the current vault. A valid update
from the already approved signer can retain approval only when it adds no
permissions. Unsigned edits, changed signers and broader permissions require review.

**Remove from device** lists the device's vaults before removal. Settings,
approval records and writable plugin data are kept. Running tasks keep their old
package files until they finish; new calls cannot use a removed package. A later
reinstall requires fresh approval in every vault, even for identical bytes and
vaults that were closed during removal. Missing packages remain visible in the
management list with a disabled state.

The root catalog is `plugins/catalog.json`. Packages are immutable, addressed by
all package bytes, including signature metadata. Downloads use
`plugin-artifacts/<plugin>/<artifact>/<version>/<sha256>/<filename>` so two builds
with the same declared version cannot overwrite each other. Scripts and preview
services receive effective settings from the backend. Settings with `scope: "D"`
are shared in root `plugin-settings.json`; `scope: "V"` stays in the vault database.
Writable `plugin-data/<plugin>` always stays inside its vault.

Migration prefers an existing valid root package, then the startup-selected vault,
then other vaults. Identical packages deduplicate. Original vault plugin folders,
settings rows and conflicting files remain intact as migration evidence; receipts
prevent them from reversing a later removal or reset. Root `plugins/<name>/`
folders can also serve as package input. Folder selection is the explicit way to
reinstall unchanged bytes after removal.

## First-party plugins

These packages ship with the app from repo-root `plugins/`; executable source
is under `plugin-sdk/bundled/`. Each documents
itself in-app via its manifest `descriptionKey`, shown in Settings → Plugins.

### Templates — `com.mindstream.templates.core`

Turns the user's own notes into reusable templates; there are no premade
templates. It contributes a **Template sources** settings section:

- **Template folder** (`source-folder`, a `folder` picker) — every note
  inside the chosen folder (at any depth) becomes a template.
- **Template tag** (`source-tag`, a `tag` picker) — every note carrying
  the chosen tag becomes a template.
- **Open new template notes** (`open-on-create`, a toggle).

It is a compiled Rust/Wasm plugin. `newFromTemplate` lists notes of any kind
matching the configured folder or tag and returns a menu of `createNoteFromNote`
effects. `renderTemplate` expands the selected note's title and body. The macro
engine belongs to the plugin; the app validates and performs the write.
It holds `notes.read` and `notes.create`. Disabling it removes its contributions.
The create menu and command palette use the same templates on mobile.

### Typst, `com.mindstream.typst`

The Rust/Wasm component renders and exports PDFs through the declared
native `typst` tool. Existing settings, source languages, toolbar items and
the `tinymist` preview service remain declarative. Without the desktop tool,
including on Android, the note stays editable in source mode.

Rebuild both committed components with `pnpm plugins:build`, using the pinned
Rust toolchain and Node >=22.11. Sources live in
[`plugin-sdk/bundled/`](../plugin-sdk/bundled/README.md); installable assets and
manifests live in `plugins/`. First-party components contain no QuickJS runtime.
The embedded app needs no Node or Rust guest compiler at runtime.

## Manifest

```jsonc
{
  "manifestVersion": 2, // required; the manifest schema this plugin targets
  "minAppVersion": "0.2.0", // optional; refuse to load below this app version
  "id": "com.author.my-plugin", // stable, dotted, lowercase — the namespace for everything below
  "name": "My Plugin",
  "version": "1.0.0",
  "runtime": "wasm", // or "manifest-only"
  "entry": "plugin.wasm", // required for wasm; a plain .wasm filename
  "limits": {
    "memoryBytes": 33554432,
    "timeoutMs": 1000
  },
  "descriptionKey": "plugin.description", // optional i18n key; a short one-line tagline
  "permissions": [], // see Permissions
  "contributes": {
    /* … */
  }
}
```

Every runtime id derived from a plugin (settings keys, command ids, i18n keys)
is namespaced under the plugin `id`, so two plugins can never collide.

### Versioning and forward compatibility

`manifestVersion` is required. Without it there is no way to tell a manifest
written for a different app version from one that is simply malformed, and the
error a plugin author sees should say which. This app writes and accepts
versions `1` and `2`. Wasm requires version `2`, which rejects Luau.
Manifest-only plugins work with either version, and can move to version `2`
without changing their contributions. A future version is refused with an
"update the app" error.

`minAppVersion` is optional and compared numerically as `major.minor.patch`.

When this app meets something it does not recognize, the rule is deliberately
asymmetric:

- an unknown **contribution** is dropped with a warning. It is additive by
  construction, so ignoring it costs the user one feature of one plugin and the
  rest of the plugin keeps working.
- an unknown **permission** is fatal. Silently ignoring one would load the
  plugin under a narrower grant than it was written for, and it would fail
  somewhere later with nothing pointing back at the cause.

### Contributions

- **`i18n`** — `{ "<locale>": { "<key>": "<string>" } }`. An `en` bundle is
  required; other locales fall back to it. Referenced by `…Key` fields elsewhere.
- **`settings`** — sections of controls shown under Settings → Plugins →
  _(your plugin)_. Each setting is stored at `plugins.<id>.<settingId>`, in the
  vault database rather than with the app's other settings — a scripted plugin
  receives them as `ctx.settings`, so the backend has to be able to read them.
  Control `type`s: `toggle`, `text`, `number`, `slider`, `select`, `radio`,
  `color`, and the vault pickers **`folder`** and **`tag`** (their value is a
  folder id / tag string and auto-clears if the target is deleted). `select` and
  `radio` settings can add `optionLabelKeys` (`{ "<option>": "<i18nKey>" }`) so
  plugin-owned values like `wysiwyg` can display domain language such as "Live
  Preview".
- **`noteKinds`** — plugin-owned note/editor surfaces. A note kind can set
  `viewModeLabelKeys` (`{ "wysiwyg": "<i18nKey>", "source": "<i18nKey>",
"split": "<i18nKey>" }`) to rename host view modes in the editor UI while the
  stored internal values remain stable.
- **`sourceLanguages`** — source-editor language modes backed by host-owned
  CodeMirror providers. A note kind references one with `sourceLanguage`. A
  language opts into spellchecking with `diagnostics` (see below).
- **`textCheckers`** — spelling/grammar services added to the diagnostics
  pipeline. The plugin declares the wire format; the host makes the request
  (see below). Requires `textCheckers.contribute`.
- **`noteExporters`** — export actions shown in a note's context menu. An
  exporter targets a built-in note kind such as `markdown` or a plugin-owned
  stored kind such as `plugin.<pluginId>.<kind>`, runs a backend script export,
  and supports `pdf`, `png`, `svg`, `typ`, `md`, `html`, `csv`, `xlsx`, `docx`,
  `json`, and `zip`. Return `{ file: { mime, dataBase64, suggestedName? } }`.
  Text formats can return `text` instead of `dataBase64`, including empty source.
  MIME must match the declared format. `requiresNativeTool` is optional, so a
  source export can work without a compiler.

  For multi-page PNG/SVG output, the first invocation can return
  `{ pagesPdf: { mime: "application/pdf", dataBase64 }, diagnostics? }`.
  The host counts the PDF pages and invokes the same export once per page,
  adding a one-based `page` to the input. Each call returns a single image file.
  One-page exports save directly; multiple pages are saved as a ZIP with
  numbered filenames. The bundled Typst plugin uses this protocol.

- **`noteTemplates`** — declarative templates (`titleTemplate` / `bodyTemplate`
  with `{{…}}` placeholders, see below). Requires `notes.create`.
- **`commands`** — app-local commands (currently `createTemplateNote`), each
  bindable to a hotkey.
- **`artifacts`** — binaries the host downloads and digest-verifies on the
  plugin's behalf, for webview renderers. Requires `pluginArtifacts.download`;
  see "Webview previews" below.
- **`nativeTools`** — PATH binaries the plugin may run, one shot at a time,
  never through a shell. Requires `nativeTools.runDeclared`.
- **`nativeServices`** — a PATH binary the host runs as a long-lived local
  preview server. Requires `nativeServices.run`.
- **`documentation`** — an ordered list of real markdown files bundled in the
  plugin, shown read-only in a navigable "View documentation" modal:
  ```jsonc
  "documentation": [
    { "file": "docs/getting-started.md" },
    { "file": "docs/placeholders.md" }
  ]
  ```
  Array order is the nav order; each section's title is the file's first `# H1`.
  Localize a section by adding a sibling with a locale suffix — `docs/getting-started.de.md`
  is used for German, falling back to `docs/getting-started.md`. Paths are
  relative to the plugin dir and must be safe (`.md`, no `..`).
- **`toolbar`** (executable runtimes) — buttons the plugin adds
  to a host toolbar (currently the file-tree toolbar). Each ships its own
  bundled `.svg` icon (rendered as a themed monochrome mask) and runs a backend
  script export on click:

  ```jsonc
  "toolbar": [{
    "id": "new-from-template",
    "location": "file-tree",
    "labelKey": "toolbar.newFromTemplate",   // plugin i18n key (tooltip)
    "icon": "icons/templates.svg",           // safe relative .svg path
    "opensMenu": true,                        // show and open as a submenu on hover
    "action": { "type": "script", "export": "newFromTemplate" }
  }]
  ```

  The export returns a **declarative effect** the app performs (see below) — so
  Set `opensMenu` when the export returns `openMenu`. The host then marks the
  button as a submenu and resolves it on hover.

  File-tree buttons can declare `visibleWhen` to hide an action until a note
  matches a configured source:

  ```json
  "visibleWhen": {
    "type": "hasMatchingNotes",
    "folderSetting": "source-folder",
    "tagSetting": "source-tag"
  }
  ```

  These are plugin-local setting IDs with types `folder` and `tag`. Supply at
  least one. The condition requires `notes.read` and matches either source,
  including descendant folders and every note kind. It excludes trashed notes
  and notes inside trashed folders. Unset sources, empty matches, unavailable
  metadata and a revoked read grant hide the action. The host uses its reactive
  metadata cache without invoking the guest or exposing note contents.
  Backend permission and note validation still apply when the action runs.
  Hidden actions retain their configured toolbar position.

### Placeholder syntax (declarative templates)

`titleTemplate` / `bodyTemplate` support `{{ base [offset] [:format] [|filter] }}`:

- built-in dates: `{{date}}`, `{{time}}`, `{{datetime}}`, `{{now}}`
- date math: `{{date+7d}}`, `{{date-1M:YYYY-MM-DD}}` (units `y M w d h m s`)
- formatting: `{{date:dddd}}`, `{{datetime:YYYY-MM-DD HH:mm}}` (moment-style tokens)
- `{{uuid}}`, and filters `|upper|lower|trim|capitalize|slug`

## Permissions

A permission names something **the host does on the plugin's behalf that
reaches outside the plugin's own bundle**. That is the whole test for whether
something belongs on this list: if refusing it would not stop the host doing
anything, it is not a permission.

The list used to be longer. It carried _contribution gates_ —
`templates.contribute`, `noteKinds.contribute`, `noteExporters.contribute` —
which only restated what `contributes` already said and gated nothing at
runtime, and `pluginWebviews.allowEval`, which is a CSP setting on one
contribution rather than a resource anyone can reach. Those are gone;
`webview.allowEval` is now just the manifest flag it always was.

| Permission                 | Grants                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `notes.read`               | read vault metadata: `notes` (titles, tags, folders, never bodies) and `ctx.folders`             |
| `notes.create`             | the app creates a note from the plugin's output. The app writes it, never the plugin             |
| `textCheckers.contribute`  | send note text to a network endpoint. The host makes the request; the plugin declares the format |
| `pluginStorage.read`       | read the plugin's own isolated data directory (`storage.read` / `.list`)                         |
| `pluginStorage.write`      | write it (`storage.write` / `.delete`)                                                           |
| `pluginArtifacts.download` | the host downloads declared artifacts and verifies their pinned digest                           |
| `nativeTools.runDeclared`  | run the plugin's declared PATH binaries, directly and never through a shell. Desktop-only        |
| `nativeServices.run`       | run a declared binary as a long-lived local preview server. Desktop-only                         |

Broad `notes.write` stays deliberately absent: the app performs every note
write, from data the plugin returns.

A manifest is rejected if it contributes something it didn't ask permission
for — the permissions list is what the user is shown at approval, so it has to
be complete. That rule lives in one table (`CONTRIBUTION_POINTS` in
`src/lib/plugins/types.ts`) read by both the validator and the contribution
registry, so what is checked and what is enforced cannot drift apart.

Each plugin's requested permissions are shown to the user (with friendly
labels) in Settings → Plugins, alongside its `descriptionKey` tagline and a
"View documentation" button that renders the `contributes.documentation` files
read-only.

### Permissions are pinned at approval

Approving a third-party plugin pins three things: its package digest, its
signer, and **the permission set the user was shown**.

An update signed by the same key auto-approves without re-prompting — but that
is a claim about _authorship_, not consent to whatever the new bytes ask for.
So an update may **narrow** its permissions freely, and one that **widens**
them is gated for re-approval with the added capabilities named. Built-in
plugins are exempt: they ship inside the signed app binary, so their manifest
is exactly as authoritative as the app asking the question.

The integrity gate is also applied at **execution** time, not only at
discovery. Every command that runs plugin code re-reads the plugin from disk
and compares its digest to the approved one first, so editing an approved
plugin while the app is running does not get those bytes executed under the
old approval.

## TypeScript plugins

Create, build and test a plugin with the [SDK starter](../plugin-sdk/typescript/README.md).
It packages the WIT contract and uses esbuild plus QuickJS to produce a component.
Authors need Node.js 20 or later, without Rust or manual WIT edits.

```ts
import {
  definePlugin,
  clock,
  markdown,
  type Context
} from '@mindstream/plugin-sdk';

export const invoke = definePlugin({
  render(ctx: Context) {
    return {
      title: `Meeting ${clock.today()}`,
      body:
        markdown.frontmatter({ type: 'meeting', attendees: [] }) +
        '\n## Notes\n'
    };
  }
});
```

Each key passed to `definePlugin` is an export name the manifest can reference.
A handler takes a JSON object and returns JSON synchronously. A promise is an
error. The ABI exports `invoke(exportName, inputJson) -> result<outputJson, string>`
from the versioned [`mindstream:plugin` WIT world](../plugin-sdk/wit/world.wit).

Ordinary TypeScript imports can split a plugin across files. The SDK bundles
those modules, including compatible JavaScript dependencies, into one component.
Node APIs, DOM APIs, generic WASI and filesystem/network imports are unavailable.
Use the host APIs below for permitted operations.

A template's `render` export returns `{ title, body }`. A note renderer returns
`{ preview: { mime, dataBase64 }, diagnostics }` or `{ sourceOnly: true }`.
An exporter receives `{ noteId, noteKind, title, body, format }` and returns
`{ file: { mime, dataBase64, suggestedName? }, diagnostics? }`. Preview-shaped
PDF results also work for exporters. The host owns the save dialog and write.

### Runtime limits and lifecycle

A shared Wasmtime engine caches compiled components. Every invocation uses a
fresh store and instance; guest globals do not persist between calls.
The runtime starts on first use, so plugin discovery does not initialize guests.
Only verified package bytes execute. Discovery rejects a Wasm package whose
declared entry is missing. Each execution uses the entry bytes captured during
package verification, including for embedded plugins; it never reopens the entry
to fill a missing snapshot. The compiled cache holds at most eight components in
memory and 32 on disk per engine compatibility key.

The default guest linear memory cap is 32 MiB, clamped to 4–256 MiB. It sums
all guest memories and does not cap host RSS. The default execution timeout is
one second, clamped to 50 ms–5 s. Native-tool wall time is credited back within
a fixed extra allowance of 30 seconds per invocation. Repeated tool runs cannot
extend that ceiling. Epoch checks interrupt loops and cancellation; native tool
waits also observe cancellation. Disabling, removing or crashing a plugin cancels
its running calls. At most four calls run concurrently; a busy caller waits up
to five seconds. Components are limited to 32 MiB and returned JSON to 64 MiB.

Host-call argument copying has its own fixed **9 MiB budget per imported host
call**. Wasmtime enforces it while lifting arguments from guest memory, before
the host handler receives owned strings and lists. The accounting includes
container overhead as well as copied data. It prevents repeated references to
one guest string from causing large host allocations before validation. The
budget resets for each host call and cannot be raised through manifest limits.
It leaves room for 8 MiB UTF-8 native-tool stdin plus 256 KiB of arguments and
binding overhead. Transfer accounting counts strings in the component's
canonical encoding, so UTF-16 arguments can reach this budget before reaching
the scalar API's UTF-8 text limit.

Exhausting this transfer budget traps and ends the invocation. It does not
return a catchable `HostError` or a batch failure/progress record. Earlier host
calls may already have produced effects; the trap does not roll them back.
The budget does not cap total host RSS, native-tool output, or host-to-guest
results. Guest invocation results retain the separate 64 MiB UTF-8 JSON limit.
The runtime allows up to 128 MiB of encoded result copying to accommodate
UTF-16, then checks the decoded UTF-8 length. Guest linear memory and the
following operation limits apply separately. MiB means 1,048,576 bytes; scalar
and batch text sizes count UTF-8 bytes.

| Operation             | Limit                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| Storage read or write | 4 MiB per file                                                             |
| Native-tool stdin     | 8 MiB                                                                      |
| Native-tool arguments | 64 arguments, at most 4,096 bytes each                                     |
| Native-tool timeout   | 10 seconds by default, clamped to 100 ms to 30 seconds and the wall budget |
| Batch request         | 128 commands, 1,024 text inputs, 1 MiB total literal data                  |
| Batch results         | 8 MiB accounted cumulative data, including unkept results                  |

Batch request validation runs after argument lifting, before executing any
operation in that batch. A request above the 1 MiB literal limit can therefore
return a normal batch validation failure if it fits the 9 MiB transfer budget.
Batch result accounting includes conservative record overhead. See
[the batch contract](plugin-host-api-design.md#the-general-batch-contract) for
failure phases and recovery.

### Effects (toolbar buttons)

A toolbar button's export is called with the context table and returns a
**declarative effect** — a closed set the app performs on the script's behalf
(the "plugin computes, app acts" rule). The script never touches the DOM:

| Effect                                                      | Does                                             |
| ----------------------------------------------------------- | ------------------------------------------------ |
| `{ effect: "none" }`                                        | nothing                                          |
| `{ effect: "toast", message, kind? }`                       | show a toast (`kind` `"info"`\|`"error"`)        |
| `{ effect: "createNote", title, body, parentId? }`          | create + open a note (needs `notes.create`)      |
| `{ effect: "createNoteFromNote", sourceNoteId, parentId? }` | copy a source note (interpolated) into a new one |
| `{ effect: "insertMarkdown", markdown }`                    | insert markdown at the active note's cursor      |
| `{ effect: "openMenu", items: [{ label, run: <effect> }] }` | show a menu; each item runs its nested effect    |

Returning a terminal effect makes the button a single action; returning
`openMenu` makes it a sub-menu. Combined with `notes` (metadata, gated by
`notes.read`) a script can enumerate and filter notes itself — the Templates
plugin lists the notes in its configured folder or tag and returns a menu of
`createNoteFromNote`.

### The context object

Every export is called with one `ctx` object. It is assembled from two halves:

| Field          | Built by | Notes                                                                               |
| -------------- | -------- | ----------------------------------------------------------------------------------- |
| `settings`     | backend  | the plugin's stored settings, read from the backend's effective root/vault settings |
| `folders`      | backend  | the vault folder tree; empty without `notes.read`                                   |
| `now`          | backend  | RFC3339, from the host clock                                                        |
| `activeNoteId` | frontend | the note on screen, or `null`                                                       |
| `locale`       | frontend | the window's current locale                                                         |

Plus whatever the call itself is about — `noteId` and `body` for a note-kind
render, `format` for an exporter, `vars` for a template.

The split is not cosmetic. Anything the backend can determine for itself, it
does, and its values win on a collision — so a caller cannot tell a script it
has settings it does not have, or hand it a false clock. It also means the
backend has everything it needs to invoke a plugin **without a UI action behind
it**, which is what a future event or watcher would require. Only the two
genuinely window-scoped fields come from the frontend.

### Host API

Import these from `@mindstream/plugin-sdk`. The host enforces permissions on
every operation, even if the plugin bypasses the SDK wrappers.

| API                                        | Permission                | Behavior                                             |
| ------------------------------------------ | ------------------------- | ---------------------------------------------------- |
| `log`, `console.log/info/warn/error/debug` | none                      | bounded app logging                                  |
| `uuid`, `randomBytes`                      | none                      | host randomness, up to 65536 bytes per call          |
| `hasPermission`                            | none                      | inspect the effective grant                          |
| `clock.now/nowMillis/today/format/add`     | none                      | local host time and moment-style formatting          |
| `markdown.frontmatter`                     | none                      | escaped YAML, keys sorted                            |
| `notes.all/get`                            | `notes.read`              | metadata snapshot, never note bodies                 |
| `storage.read/readJson/list`               | `pluginStorage.read`      | plugin-owned files; missing files return `undefined` |
| `storage.write/writeJson/delete`           | `pluginStorage.write`     | contained relative paths; at most 4 MiB per file     |
| `nativeTools.available/run`                | `nativeTools.runDeclared` | declared PATH binaries, launched directly            |

Host refusals throw `HostError` with `kind` equal to `denied`, `invalid`,
`unavailable` or `failed`. A missing permission is `denied`. Timeouts and
cancellation stop the call rather than returning a catchable host error.

`NoteMeta` uses `folderId` and `folderPath`. Use `clock.format` for local dates
and `ctx.locale` for month and weekday names. Guest JavaScript dates use UTC.
`clock.add` shifts days and weeks by elapsed durations and clamps month/year
shifts at the month's end. `Date.now`, `Math.random` and `crypto` ask the host
for fresh values; calls made during module initialization are unsupported
because the build snapshots module state before a host exists.

Native-tool options are `{ args?, stdin?, timeoutMs?, outputBase64? }`.
The result is `{ statusCode, stdout, stdoutBase64?, stderr, timedOut }`.
With `outputBase64: true`, raw bytes travel as `stdoutBase64` and `stdout` is
empty. Every tool must be declared in `contributes.nativeTools`; a plugin cannot
choose arbitrary executable paths. Mobile hosts report tools unavailable, so
check `available` before running one.

A note kind can set `render.requiresNativeTool` to let the host fall back to
source-only mode before invoking its renderer. The Typst plugin pipes its
source through `typst compile --format pdf - -` and returns a base64 PDF carrying
all pages. Its preview service remains a separate host-owned capability.

The ABI reserves future `mindstream:ai` and `mindstream:ocr` capability namespaces.
They are design boundaries only. SDK v0.1 exposes no inference, embeddings,
semantic-search or handwriting functions. A future host API should use opaque
model and attachment IDs, explicit grants and cancellable asynchronous jobs.

## Source editor language modes

Plugin-owned note kinds can opt into syntax highlighting by setting
`noteKinds[].sourceLanguage` and contributing a matching `sourceLanguages` entry:

```jsonc
"sourceLanguages": [{
  "id": "typst",
  "labelKey": "notes.document.label",
  "aliases": ["typ"],
  "extensions": ["typ"],
  "provider": { "type": "host", "id": "typst" }
}]
```

The provider is always host-owned, and the host list is currently exactly one
entry: `typst`. So this contribution point lets a plugin _select_ a highlighting
mode the app already ships — it is not a way to add one. A plugin cannot inject
JavaScript into the editor, and adding a new host provider needs an app release.

If your language is not on that list, reach for `diagnostics.grammar` below,
which is the genuinely extensible half: it describes a language the app has
never heard of, in data. Unknown source languages remain editable as plain
text.

### Spelling and grammar checking

A source language is spellchecked only if it says so, with exactly one of
`diagnostics.syntax` or `diagnostics.grammar`. Omit the block and the language
is left unchecked — the app never guesses that a plugin's notes are prose.

`syntax` names a language the app already has code for (`markdown`, `plain`,
`typst`). Prefer it wherever one fits: it is a real parser rather than a span
matcher, and only it can express things like Typst's `[...]` content blocks
being prose again inside code.

```jsonc
"diagnostics": { "syntax": "typst" }
```

`grammar` describes a language the app has never heard of, in literal
delimiters the host scans with. Every field is optional:

```jsonc
"diagnostics": {
  "grammar": {
    "lineComments": ["%"],                 // to end of line
    "blockComments": [["\\begin{comment}", "\\end{comment}"]],
    "verbatim":      [["\\begin{verbatim}", "\\end{verbatim}"]],
    "math":          [["$$", "$$"], ["$", "$"], ["\\[", "\\]"]],
    "escape": "\\",        // one char; makes the next character literal
    "indentation": true,   // ignore leading whitespace — see below
    "addresses": true,     // skip URLs and emails (default true)
    "ignorePatterns": ["(\\\\[a-zA-Z]+)\\{", "\\\\(?:ref|cite)\\{[^}]*\\}"]
  }
}
```

Delimiters are **literal text**: at most 24 entries per list, 32 characters
each, so the per-character cost stays flat. Spans do not nest, the longest
matching opener at a position wins, and an unterminated span runs to the end of
the text rather than guessing a closer — half-typed markup is normal while
writing. Openers are matched before the `escape` character, so a language whose
delimiters begin with its escape character (LaTeX) still works.

`ignorePatterns` covers what delimiters cannot. `\textbf{bold text}` must lose
the command and **keep** the argument, which no pair of delimiters expresses —
it either swallows the prose or feeds `textbf` to the dictionary.

- **Capture groups scope the ignore.** No group → the whole match is skipped.
  Groups → only the groups are, so `(\\[a-zA-Z]+)\{` drops the command and
  still checks its argument.
- Flags are the host's (`gd`, plus `u` when the pattern accepts it — `\p{L}`
  works, and patterns Unicode mode rejects still compile). A plugin cannot set
  them, because turning off `d` would break capture-group scoping.
- Backreferences are rejected: they force backtracking however simple the rest
  of the pattern looks. At most 16 patterns, 200 characters each.

**Patterns run in a Worker with a hard timeout, and the Worker is terminated if
it overruns.** This is the same bargain scripted plugins get from
`limits.timeoutMs` — a plugin fault costs the plugin, not the app. It is not
optional hardening: no static check reliably separates a regex that backtracks
catastrophically from one that does not (star-height tests miss `(a|ab)*`), and
a single match cannot be interrupted once started, so termination is the only
thing that actually stops one. The realistic danger is not a hostile plugin but
an ordinary pattern that is instant on the author's test file and exponential on
someone's long unbroken line.

When a grammar overruns, it is faulted **for the rest of the session** — asked
again next keystroke it would freeze again — and the language falls back to its
delimiters, with the reason shown against the plugin in Settings. Where no
Worker exists (SSR, tests) patterns simply do not run; there is no inline
fallback, since that would quietly discard the guarantee.

Set `indentation` only where leading whitespace _means_ something, as in
Markdown lists or Typst blocks. A grammar checker reporting "more than one
space in a row" on an indented line is commenting on the document's structure,
not the author's typing. Where indentation carries no meaning, leave it off so a
genuine doubled space is still caught. Note this is filtered by POSITION rather
than by the checker's message, which arrives already localized and so cannot be
matched against.

## Text checkers (`contributes.textCheckers`, `textCheckers.contribute`)

A plugin can add a spelling/grammar/style service to the diagnostics pipeline.
The plugin describes the service; **the host makes every request**. That split is
the point: a checker sees the full text of every note the user types in, so a
plugin declares a wire format but never receives the text and never chooses
where it goes.

The host also has to make the request for it to work at all. A self-hosted
server sends no CORS headers, so a WebView `fetch` to the usual setup is refused
before it leaves; Chromium gates page-to-LAN requests through Private Network
Access; and where the app is served from a custom scheme treated as secure, a
plain-`http://` server is blocked as mixed content. `reqwest` in the backend is
subject to none of the three.

```jsonc
"textCheckers": [{
  "id": "grammar",
  "kinds": ["grammar", "style", "spelling"],
  "labelKey": "checker.label",

  // Settings the user fills in. The endpoint is a setting, not a manifest
  // value, because it is the user's choice — their own server, or a public one
  // with very different privacy implications.
  "endpointSetting": "endpoint",
  "apiKeySetting": "api-key",
  "usernameSetting": "username",

  // Declaring `spelling` in `kinds` says the checker CAN do spelling; this
  // setting says whether it does, so a user can keep the built-in dictionary
  // without disabling the plugin. Omit it and the checker always does.
  "spellingSetting": "spelling",
  // Categories to switch off server-side when it is not doing spelling —
  // the service's vocabulary, which only the plugin knows.
  "spellingCategories": ["TYPOS"],
  "disabledCategories": [],

  // The service's rule categories mapped to diagnostic kinds. Anything
  // unlisted falls back to `defaultKind`.
  "defaultKind": "grammar",
  "categoryKinds": { "TYPOS": "spelling", "STYLE": "style" },

  "protocol": { /* see below */ }
}]
```

### The protocol

`protocol` is how a service is described rather than named. It replaced a
host-owned list of supported protocols that had exactly one entry, which meant
a second service required an app change and a third-party plugin could not add
one at all.

```jsonc
"protocol": {
  // Stripped from the user's endpoint before paths are appended. People paste
  // whatever their server's docs show — often the API root including its
  // version segment — which would otherwise build `/v2/v2/check` and 404 as an
  // unreachable server rather than a URL one segment too long.
  "trimEndpointSuffix": "/v2",

  "check": {
    "path": "/v2/check",
    "encoding": "form",              // "form" or "json"
    // Where the host's values go. A field left out is simply not sent, which
    // is how a service with no concept of an API key omits one.
    "fields": {
      "text": "text",                // REQUIRED
      "language": "language",
      "apiKey": "apiKey",
      "username": "username",
      "preferredVariants": "preferredVariants",
      "disabledCategories": "disabledCategories"
    },
    "staticFields": { "level": "picky" }   // sent verbatim every time
  },

  // Where the findings are, as JSON Pointers (RFC 6901). `list` is
  // document-relative; the rest are relative to each match.
  "matches": {
    "list": "/matches",
    "offset": "/offset",
    "length": "/length",             // exactly one of length or end
    "message": "/message",
    "replacements": "/replacements",
    "replacementValue": "/value",    // omit if they are plain strings
    "category": "/rule/category/id"
  },

  // Optional. Declaring it switches on the host's re-ask behaviour: when
  // detection lands outside the languages the user writes, the request is
  // repeated naming a language outright. Checking German prose against a
  // French dictionary produces far more nonsense than the wrong regional
  // variant. A detection naming a language the user DOES write is taken at
  // its word however sure the service sounds — a short fragment scores low
  // whether the guess is right or wrong, so a score floor threw away correct
  // answers to catch wrong ones this test already catches.
  "detection": {
    "code": "/language/detectedLanguage/code",
    // Optional, and read by nothing today. Declare it if the service
    // reports a score; omitting it costs the checker nothing.
    "confidence": "/language/detectedLanguage/confidence"
  },

  // Optional. A cheap endpoint listing the languages the server offers, used
  // by the Check button. Kept apart from the check path so that answering
  // "is my container up?" transmits nothing. Without it, the button falls back
  // to a fixed probe string — never note content.
  "probe": {
    "path": "/v2/languages",
    "list": "",                      // "" is the document root
    "languageCode": ["/longCode", "/code"]   // tried in order
  }
}
```

Pointers rather than a query language: they are a standard, they cannot loop or
backtrack, and they resolve natively in the backend. A match whose offset,
extent or message cannot be resolved is **dropped** rather than defaulted — a
finding at a guessed position underlines the wrong words, which is worse than
one that never appears.

The bundled `languagetool` plugin is a complete worked example, and is nothing
but a manifest: the app contains no code specific to it. A service whose
response cannot be described with pointers — XML, or two round trips — is
outside what a declarative protocol can express today.

## Webview previews (`render.webview`, `contributes.artifacts`)

Some renderers only exist as JavaScript. A note kind can therefore render
itself in a **sandboxed iframe** instead of through a backend script export, by
giving its `render` a `webview`:

```jsonc
"noteKinds": [{
  "id": "diagram",
  "labelKey": "notes.diagram.label",
  "render": {
    "export": "renderDiagram",     // still required: the fallback path
    "webview": {
      "entry": "preview.mjs",      // safe relative .js/.mjs inside the plugin
      "allowEval": false,          // CSP 'unsafe-eval', for generated WASM glue
      "artifacts": ["engine"]      // artifact ids delivered before first render
    }
  }
}]
```

This is a real code-execution tier and worth being precise about, because the
boundary is not the one the rest of this document describes.

**What it is not.** The module does _not_ run in the app's WebView, and it
cannot reach the editor, the DOM of the app, the vault, or any Tauri command.
It is not a way to extend the editor — see "Source editor language modes" for
why that stays host-owned.

**What it is.** The module runs in an iframe on its own origin, under a
restrictive CSP, talking to the host only over `postMessage` with the note body
in and rendered output back. `allowEval` relaxes the CSP to permit
`'unsafe-eval'` within that iframe, which some generated WASM glue requires; it
is a manifest flag rather than a permission, because it widens nothing outside
the sandbox the plugin already has.

### Artifacts

A webview renderer usually needs a binary it would be absurd to vendor — a WASM
engine, a font bundle. `contributes.artifacts` declares one, and the **host**
fetches it; plugin code never performs the download.

```jsonc
"artifacts": [{
  "id": "engine",
  "kind": "wasm",                  // "wasm" | "webScript" | "data"
  "version": "0.13.1",
  "url": "https://example.com/engine.wasm",   // HTTPS only
  "sha256": "…",                   // pinned digest, lowercase hex
  "fileName": "engine.wasm",
  "sizeBytes": 12345678            // optional exact length
}]
```

Requires `pluginArtifacts.download`. The digest is the point: it is checked
after download and again on every read, and the bytes are written through a
staging file so a failed transfer can never leave a half-file where the loader
expects a whole one. A mismatch is refused rather than repaired — that is what
catches a truncated transfer, a host that started serving an HTML error page,
and a swapped file. Artifacts are stored per plugin and per version, and
delivered to the iframe as Blob URLs before the first render.

## Preview services (`contributes.nativeServices`, `nativeServices.run`)

Some tools are **live servers**, not one-shot commands. `contributes.nativeServices`
declares a PATH binary the host runs as a persistent local process whose own web
frontend is shown in the note's preview iframe — the motivating case is
`tinymist preview`, which gives bidirectional **click-to-source** (click the
rendered output → the source caret jumps there). Desktop-only; gated on
`nativeServices.run`.

A service entry declares `binaryName`, an `args` template (placeholders
`{dataPort}`, `{controlPort}` — host-allocated free ports — `{input}`, the
absolute path to the materialized source file, and `{setting:<id>}`, resolved
from the plugin's own settings so a launch flag can be a user toggle, e.g.
`--partial-rendering {setting:partial-rendering}`), a loopback `dataUrl`
(`http://127.0.0.1:{dataPort}`, validated to be loopback-only so a plugin can't
frame a remote origin), a loopback `controlUrl` (`ws://127.0.0.1:{controlPort}`),
and a `protocol.jumpEvent` (the control-plane message the host maps to a caret
jump; payload `{ filepath, start:[line,col] }`, 0-indexed). A note kind opts in
with `render.previewService = "<id>"`; the host still falls back to the
`export` / `requiresNativeTool` render when the service binary isn't installed.

By default, the iframe loads `dataUrl` **unmodified**. A service can opt into the
host's themed proxy with:

```jsonc
"previewIframe": {
  "mode": "themed",
  "css": "preview.css" // optional, plugin-relative .css file
}
```

`mode: "themed"` serves the preview frontend through a per-session loopback proxy
that injects host-owned theme variables (`--ms-preview-background`,
`--ms-preview-foreground`, `--ms-preview-gutter`, `--ms-preview-scrollbar`) and
the host's preview scrollbar/layout CSS. If `css` is present, the file is read
from the approved plugin bundle, must be a safe relative `.css` path, is capped
in size, and is injected after the host CSS. Use this for service-specific
bridges such as mapping the host background token to a frontend-specific custom
property. The proxy keeps the preview document on loopback, applies a restrictive
CSP, and rejects CSS content that could break out of the injected `<style>`.

A `{setting:<id>}` value is restricted to a safe CLI charset before it is
substituted: ASCII alphanumerics plus `. _ - : +`, capped at 64 characters, with
any leading `-` stripped so a value cannot masquerade as a flag. Nothing is run
through a shell either way — the binary is launched directly — but these values
originate with the user, so they are constrained regardless.

The host owns the whole lifecycle: it allocates the ports, writes the body to a
temp file the server watches (rewritten on edit), waits for readiness, connects
the control plane as the editor, and reaps the process when the note closes or
the app exits.

## Editor setup and local tests

The TypeScript starter includes a strict `tsconfig.json`. Run `npm run typecheck`
for the guest and use `@mindstream/plugin-sdk/testing` in Node tests against the
built component. The harness provides an in-memory host with explicit permissions,
notes, folders, settings, storage and mock native tools. It creates a fresh
instance for every call, matching the app. Resource interruption, cancellation
and process behavior are covered by the Rust runtime suite.

Run `npm run test:plugin-author` in the repository to check the packed SDK in
an isolated directory without Cargo or rustc. `pnpm test` includes the SDK and
bundled-component behavior tests. `pnpm plugins:build` rebuilds bundled bytes.

## Signing (third-party plugins)

Signing proves authorship and lets a plugin's own updates auto-approve instead
of re-prompting. A signed plugin ships `signature.json` next to `manifest.json`:
an Ed25519 signature over the plugin's **package digest** (a content hash of
every file, so the signature covers components, docs and icons — not just the
manifest).

```bash
# generate a key OUTSIDE the plugin dir, and sign
node src-tauri/scripts/sign-plugin.mjs <plugin-dir> --generate ../my-key.pem
# re-sign after editing (same key ⇒ updates auto-approve)
node src-tauri/scripts/sign-plugin.mjs <plugin-dir> --key ../my-key.pem
```

**Integrity gate:** an installed plugin whose package hash changes is disabled
until re-approved — unless the change is validly signed by the **same** key it
was first approved with. Built-in plugins are trusted by location and skip the
gate.
