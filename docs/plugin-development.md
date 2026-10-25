# Writing plugins

A plugin is a folder with a `manifest.json` and any assets it refers to. A
manifest-only plugin contributes data, such as settings, templates or a text
checker. An executable plugin adds a `.wasm` component that runs in the app's
Rust backend. The host controls permissions, resource limits and every effect a
plugin has. How people install and approve plugins is in [Plugins](plugins.md).

## Getting started

The contract is the versioned
[`mindstream:plugin` WIT world](../plugin-sdk/wit/world.wit), so any language
with component bindings can target it. Rust and TypeScript are the tested
paths:

- The [Rust starter](../plugin-sdk/rust/README.md) is what the core plugins
  use.
- The [TypeScript SDK](../plugin-sdk/typescript/README.md) needs only Node.js
  22.11 or later.
- The [examples](../plugin-sdk/examples/README.md) are installable TypeScript
  versions of the Templates and Typst plugins.

A guest must implement the component world and the JSON protocol below. A core
Wasm module, a WASI command or code that expects browser or Node imports cannot
be installed unchanged.

To try a build, install its folder with **Settings → Plugins → Install or update
from folder…** and approve it in the vault.

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

`manifestVersion` is required, so that the app can tell a manifest written for
another app version from one that is malformed. This app writes and accepts
version `2`. An older version is refused with an "update the plugin" error, and
a future version with an "update the app" error.

`minAppVersion` is optional and compared numerically as `major.minor.patch`.

When the app meets something it does not recognise, the rule is deliberately
asymmetric:

- An unknown **contribution** is dropped with a warning, and the rest of the
  plugin keeps working.
- An unknown **permission** is fatal. Ignoring it would load the plugin with
  less access than it was written for, and it would fail later with nothing
  pointing back at the cause.

### Contributions

- **`i18n`** — `{ "<locale>": { "<key>": "<string>" } }`. An `en` bundle is
  required; other locales fall back to it. Referenced by `…Key` fields elsewhere.
- **`settings`** — sections of controls shown under **Settings → Plugins** for
  your plugin. Each setting is stored at `plugins.<id>.<settingId>`, and
  executable plugins receive the values as `ctx.settings`. Its `scope` is `"V"`
  to keep the value per vault, or `"D"` to share it between every vault on the
  device. Control `type`s: `toggle`, `text`, `number`, `slider`, `select`,
  `radio`, `color`, and the vault pickers **`folder`** and **`tag`** (their value
  is a folder id or tag string, and clears itself when the target is deleted).
  `select` and `radio` settings can add `optionLabelKeys`
  (`{ "<option>": "<i18nKey>" }`) so plugin-owned values like `wysiwyg` can
  display domain language such as "Live Preview".
- **`noteKinds`** — plugin-owned note and editor surfaces. A note kind can set
  `viewModeLabelKeys` (`{ "wysiwyg": "<i18nKey>", "source": "<i18nKey>",
"split": "<i18nKey>" }`) to rename the host's view modes in the editor while
  the stored values stay the same.
- **`sourceLanguages`** — source-editor language modes backed by host-owned
  CodeMirror providers. A note kind references one with `sourceLanguage`. A
  language opts into spellchecking with `diagnostics` (see below).
- **`textCheckers`** — spelling, grammar and style services added to the
  diagnostics pipeline. The plugin declares the wire format; the host makes the
  request (see below). Requires `textCheckers.contribute`.
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
  numbered filenames. The Typst plugin uses this protocol.

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
- **`documentation`** — an ordered list of Markdown files bundled in the plugin,
  shown read-only behind the plugin's documentation button in Settings:
  ```jsonc
  "documentation": [
    { "file": "docs/getting-started.md" },
    { "file": "docs/placeholders.md" }
  ]
  ```
  Array order is the navigation order; each section's title is the file's first
  `# H1`. Localise a section by adding a sibling with a locale suffix:
  `docs/getting-started.de.md` is used for German, falling back to
  `docs/getting-started.md`. Paths are relative to the plugin folder and must be
  safe (`.md`, no `..`).
- **`toolbar`** (executable runtimes) — buttons the plugin adds to a host
  toolbar (currently the file-tree toolbar). Each ships its own bundled `.svg`
  icon, rendered as a themed monochrome mask, and runs a backend script export
  on click:

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

  The export returns a **declarative effect** the app performs (see below).
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
  metadata and a revoked permission hide the action. The host decides from its
  own metadata cache, without calling the plugin or exposing note contents.
  Permission and note checks still apply when the action runs. Hidden actions
  keep their place in the toolbar.

### Placeholder syntax (declarative templates)

`titleTemplate` / `bodyTemplate` support `{{ base [offset] [:format] [|filter] }}`:

- built-in dates: `{{date}}`, `{{time}}`, `{{datetime}}`, `{{now}}`
- date math: `{{date+7d}}`, `{{date-1M:YYYY-MM-DD}}` (units `y M w d h m s`)
- formatting: `{{date:dddd}}`, `{{datetime:YYYY-MM-DD HH:mm}}` (moment-style tokens)
- `{{uuid}}`, and filters `|upper|lower|trim|capitalize|slug`

## Permissions

A permission names something **the host does on the plugin's behalf that
reaches outside the plugin's own files**. If refusing it would not stop the host
doing anything, it is not a permission.

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

There is deliberately no `notes.write`: the app performs every note write, from
data the plugin returns.

A manifest is rejected if it contributes something it did not ask permission
for. The permission list is what people see when they approve the plugin, so it
has to be complete. Settings → Plugins shows it with friendly labels, beside the
`descriptionKey` tagline and the plugin's documentation.

### Permissions are pinned at approval

Approving a third-party plugin pins three things: its package digest, its
signer, and **the permission set the user was shown**.

An update signed by the same key is approved without asking again, but only for
the permissions already approved. An update may **narrow** its permissions
freely; one that **widens** them waits for a new approval that names the added
permissions. Core plugins are exempt, because they ship inside the app.

The check also runs every time plugin code runs, not only when the app finds
the plugin. Each call re-reads the plugin from disk and compares its digest to
the approved one, so editing an approved plugin while the app is running does
not get the new bytes run under the old approval.

## TypeScript plugins

Create, build and test a plugin with the
[SDK starter](../plugin-sdk/typescript/README.md). It packages the WIT contract
and uses esbuild plus QuickJS to produce a component. You need Node.js 22.11 or
later, and no Rust or WIT edits.

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
from the [`mindstream:plugin` WIT world](../plugin-sdk/wit/world.wit).

Ordinary TypeScript imports can split a plugin across files. The SDK bundles
those modules, including compatible JavaScript dependencies, into one component.
Node APIs, DOM APIs, generic WASI and filesystem/network imports are unavailable.
Use the host APIs below for permitted operations.

A template's `render` export returns `{ title, body }`. A note renderer returns
`{ preview: { mime, dataBase64 }, diagnostics }` or `{ sourceOnly: true }`.
An exporter receives `{ noteId, noteKind, title, body, format }` and returns
`{ file: { mime, dataBase64, suggestedName? }, diagnostics? }`. Preview-shaped
PDF results also work for exporters. The host owns the save dialog and write.

### Runtime limits

Every invocation gets a fresh instance, so guest globals do not persist between
calls; keep state with the storage API. The runtime starts on first use, and
only the package bytes that passed verification ever run.

The default guest linear memory cap is 32 MiB, clamped to 4–256 MiB. It sums
all guest memories and does not cap host RSS. The default execution timeout is
one second, clamped to 50 ms–5 s. Time spent waiting for a native tool is
credited back, up to 30 extra seconds per invocation however many tools run.
Loops and cancellation are interrupted, and native-tool waits observe
cancellation too. Disabling, removing or crashing a plugin cancels its running
calls. At most four calls run at once; a busy caller waits up to five seconds.
Components are limited to 32 MiB and returned JSON to 64 MiB.

Each imported host call also has a fixed **9 MiB budget for copying its
arguments** out of guest memory. It is checked while the arguments are lifted,
before the host handler runs, counts container overhead as well as data, and
cannot be raised through manifest limits. It leaves room for 8 MiB of UTF-8
native-tool stdin plus 256 KiB of arguments and binding overhead. Strings count
in the component's canonical encoding, so UTF-16 arguments can reach the budget
before they reach the scalar API's UTF-8 text limit.

Exhausting that budget traps and ends the invocation. It does not return a
catchable `HostError` or a batch failure record, and effects from earlier host
calls are not rolled back. The budget does not cap host RSS, native-tool output
or results returned to the guest. Invocation results keep their own 64 MiB
UTF-8 JSON limit. MiB means 1,048,576 bytes; text sizes count UTF-8 bytes.

| Operation             | Limit                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| Storage read or write | 4 MiB per file                                                             |
| Native-tool stdin     | 8 MiB                                                                      |
| Native-tool arguments | 64 arguments, at most 4,096 bytes each                                     |
| Native-tool timeout   | 10 seconds by default, clamped to 100 ms to 30 seconds and the wall budget |
| Batch request         | 128 commands, 1,024 text inputs, 1 MiB total literal data                  |
| Batch results         | 8 MiB accounted cumulative data, including unkept results                  |

A batch request is validated after its arguments are lifted and before any of
its operations run, so a request over the 1 MiB literal limit that fits the
9 MiB budget gets a normal validation failure. See
[the batch contract](plugin-batch-api.md#the-general-batch-contract) for
failure phases and recovery.

### Effects (toolbar buttons)

A toolbar button's export is called with the context object and returns a
**declarative effect**: one of a closed set the app performs on the plugin's
behalf. The plugin computes, the app acts, and the plugin never touches the
page:

| Effect                                                      | Does                                             |
| ----------------------------------------------------------- | ------------------------------------------------ |
| `{ effect: "none" }`                                        | nothing                                          |
| `{ effect: "toast", message, kind? }`                       | show a toast (`kind` `"info"`\|`"error"`)        |
| `{ effect: "createNote", title, body, parentId? }`          | create + open a note (needs `notes.create`)      |
| `{ effect: "createNoteFromNote", sourceNoteId, parentId? }` | copy a source note (interpolated) into a new one |
| `{ effect: "insertMarkdown", markdown }`                    | insert Markdown at the active note's cursor      |
| `{ effect: "openMenu", items: [{ label, run: <effect> }] }` | show a menu; each item runs its nested effect    |

Returning a terminal effect makes the button a single action; returning
`openMenu` makes it a submenu. With `notes` (metadata, behind `notes.read`) a
plugin can list and filter notes itself: the Templates plugin lists the notes in
its configured folder or tag and returns a menu of `createNoteFromNote`.

### The context object

Every export is called with one `ctx` object, assembled from two halves:

| Field          | Built by | Notes                                                                               |
| -------------- | -------- | ----------------------------------------------------------------------------------- |
| `settings`     | backend  | the plugin's stored settings, read from the backend's effective root/vault settings |
| `folders`      | backend  | the vault folder tree; empty without `notes.read`                                   |
| `now`          | backend  | RFC3339, from the host clock                                                        |
| `activeNoteId` | frontend | the note on screen, or `null`                                                       |
| `locale`       | frontend | the window's current locale                                                         |

Plus whatever the call itself is about: `noteId` and `body` for a note-kind
render, `format` for an exporter, `vars` for a template.

The backend's values win on a collision, so a plugin can rely on `settings`,
`folders` and `now` whoever triggered the call.

### Host API

Import these from `@mindstream/plugin-sdk`. The host enforces permissions on
every operation, even if the plugin bypasses the SDK wrappers.

| API                                        | Permission                | Behaviour                                            |
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

The experimental `batch.execute` sends a list of these calls in one crossing;
see [Batching host calls](plugin-batch-api.md).

`NoteMeta` uses `folderId` and `folderPath`. Use `clock.format` for local dates
and `ctx.locale` for month and weekday names. Guest JavaScript dates use UTC.
`clock.add` shifts days and weeks by elapsed durations and clamps month/year
shifts at the month's end. `Date.now`, `Math.random` and `crypto` ask the host
for fresh values; calls made during module initialisation are unsupported
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
all pages. Its preview service is a separate host-owned capability.

SDK v0.1 has no inference, embeddings, semantic-search or handwriting
functions.

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
entry: `typst`. So this contribution lets a plugin _select_ a highlighting mode
the app already ships; it is not a way to add one. A plugin cannot inject
JavaScript into the editor, and a new host provider needs an app release.

If your language is not on that list, use `diagnostics.grammar` below: it
describes a language the app has never heard of, in data. Unknown source
languages stay editable as plain text.

### Spelling and grammar checking

A source language is spellchecked only if it says so, with exactly one of
`diagnostics.syntax` or `diagnostics.grammar`. Omit the block and the language
is left unchecked: the app never guesses that a plugin's notes are prose.

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
each. Spans do not nest, the longest matching opener at a position wins, and an
unterminated span runs to the end of the text rather than guessing a closer,
because half-typed markup is normal while writing. Openers are matched before
the `escape` character, so a language whose delimiters begin with its escape
character (LaTeX) still works.

`ignorePatterns` covers what delimiters cannot. `\textbf{bold text}` must lose
the command and **keep** the argument, which no pair of delimiters expresses.

- **Capture groups scope the ignore.** No group → the whole match is skipped.
  Groups → only the groups are, so `(\\[a-zA-Z]+)\{` drops the command and
  still checks its argument.
- Flags are the host's (`gd`, plus `u` when the pattern accepts it — `\p{L}`
  works, and patterns Unicode mode rejects still compile). A plugin cannot set
  them, because turning off `d` would break capture-group scoping.
- Backreferences are rejected, because they force backtracking. At most 16
  patterns, 200 characters each.

**Patterns run in a Worker with a hard timeout, and the Worker is terminated if
it overruns.** A pattern that is instant on your test file can still be
exponential on someone's long unbroken line. When a grammar overruns, it is
switched off **for the rest of the session** and the language falls back to its
delimiters, with the reason shown against the plugin in Settings. Where no
Worker exists (SSR, tests) patterns do not run at all.

Set `indentation` only where leading whitespace _means_ something, as in
Markdown lists or Typst blocks, so a grammar checker does not report "more than
one space in a row" on an indented line. Where indentation carries no meaning,
leave it off so a genuine doubled space is still caught.

## Text checkers (`contributes.textCheckers`, `textCheckers.contribute`)

A plugin can add a spelling, grammar or style service to the diagnostics
pipeline. The plugin describes the service; **the host makes every request**. A
checker sees the full text of every note the user types in, so the plugin
declares a wire format but never receives the text and never chooses where it
goes. Because the request comes from the backend rather than the WebView, it
also reaches self-hosted servers on plain HTTP or the local network.

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

`protocol` describes a service instead of naming one, so a plugin can add a
checker the app has no code for.

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
  // repeated naming a language outright.
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

A match whose offset, extent or message cannot be resolved is **dropped**
rather than defaulted, because a finding at a guessed position underlines the
wrong words.

The LanguageTool plugin is a complete worked example, and is nothing but a
manifest: the app contains no code specific to it. A service whose response
cannot be described with pointers, such as XML or two round trips, is outside
what the protocol can express today.

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

This runs your JavaScript, but not in the app's WebView. The module cannot reach
the editor, the app's page, the vault or any Tauri command, so it is not a way
to extend the editor.

The module runs in an iframe on its own origin, under a restrictive CSP, and
talks to the host only over `postMessage`: the note body goes in, rendered
output comes back. `allowEval` relaxes the CSP to permit `'unsafe-eval'` inside
that iframe, which some generated WASM glue needs. It is a manifest flag rather
than a permission, because it widens nothing outside the sandbox.

### Artifacts

A webview renderer usually needs a binary you would not want to vendor, such as
a WASM engine or a font bundle. `contributes.artifacts` declares one, and the
**host** fetches it; plugin code never performs the download.

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

Requires `pluginArtifacts.download`. The digest is checked after download and
again on every read, and a mismatch is refused rather than repaired, which
catches a truncated transfer, a server that started returning an HTML error page,
and a swapped file. Artifacts are stored per plugin and per version, and handed
to the iframe as Blob URLs before the first render.

## Preview services (`contributes.nativeServices`, `nativeServices.run`)

Some tools are **live servers**, not one-shot commands.
`contributes.nativeServices` declares a PATH binary the host runs as a
persistent local process whose own web frontend is shown in the note's preview
iframe. The motivating case is `tinymist preview`, which gives two-way
**click-to-source**: click the rendered output and the source caret jumps
there. Desktop-only; requires `nativeServices.run`.

A service entry declares:

- `binaryName`.
- An `args` template. Its placeholders are `{dataPort}` and `{controlPort}`
  (free ports the host allocates), `{input}` (the absolute path to the
  materialised source file) and `{setting:<id>}`, resolved from the plugin's own
  settings so a launch flag can be a user toggle, e.g.
  `--partial-rendering {setting:partial-rendering}`.
- A loopback `dataUrl` (`http://127.0.0.1:{dataPort}`). It must be loopback, so
  a plugin cannot frame a remote origin.
- A loopback `controlUrl` (`ws://127.0.0.1:{controlPort}`).
- A `protocol.jumpEvent`: the control-plane message the host maps to a caret
  jump, with payload `{ filepath, start:[line,col] }`, 0-indexed.

A note kind opts in with `render.previewService = "<id>"`; the host still falls
back to the `export` / `requiresNativeTool` render when the service binary is
not installed.

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
the host's preview scrollbar and layout CSS. If `css` is present, the file is
read from the approved plugin, must be a safe relative `.css` path, is capped in
size, and is injected after the host CSS. Use it for service-specific bridges,
such as mapping the host background token to a frontend-specific custom
property. The proxy keeps the preview document on loopback, applies a
restrictive CSP, and rejects CSS that could break out of the injected `<style>`.

A `{setting:<id>}` value is restricted to a safe CLI charset before it is
substituted: ASCII alphanumerics plus `. _ - : +`, capped at 64 characters, with
any leading `-` stripped so a value cannot pass itself off as a flag. Nothing
runs through a shell either way, but these values come from the user, so they
are constrained regardless.

The host owns the whole lifecycle: it allocates the ports, writes the body to a
temp file the server watches (rewritten on edit), waits for readiness, connects
the control plane as the editor, and stops the process when the note closes or
the app exits.

## Editor setup and local tests

The TypeScript starter includes a strict `tsconfig.json`. Run `npm run typecheck`
for the guest and use `@mindstream/plugin-sdk/testing` in Node tests against the
built component. The harness provides an in-memory host with explicit
permissions, notes, folders, settings, storage and mock native tools. It creates
a fresh instance for every call, matching the app.

## Signing your plugin

Signing proves authorship and lets a plugin's own updates keep their approval
instead of asking again. A signed plugin ships `signature.json` next to
`manifest.json`: an Ed25519 signature over the plugin's **package digest**, a
content hash of every file, so the signature covers components, docs and icons
as well as the manifest.

The signing script is one file that needs nothing but Node.js, so it works
outside this repository. Download it once:

```bash
curl -fLO https://raw.githubusercontent.com/jannikgohr/mindstream-notes/main/src-tauri/scripts/sign-plugin.mjs
```

Sign the finished package folder after its last change: `dist/package` from
the TypeScript SDK, `dist` from the Rust starter. Keep the key outside that
folder, because the signature covers every file in it.

```bash
# the first time: make a key and sign with it
node sign-plugin.mjs dist/package --generate ../my-key.pem
# every later release: sign with the same key, so updates auto-approve
node sign-plugin.mjs dist/package --key ../my-key.pem
```

The key is your identity as the plugin's author. An update signed with it
installs without a prompt as long as it asks for no new permissions, so keep
it secret. A lost key means every user approves your next release again by
hand.
