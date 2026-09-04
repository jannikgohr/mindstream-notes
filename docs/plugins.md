# Plugins

Mindstream Notes has a small plugin system. A plugin is a folder with a
`manifest.json` (and, for scripted plugins, a `.luau` entry). Plugins are
**data-first**: most extend the app declaratively, and only opt into a sandboxed
script when they need real logic.

## Where plugins live

| Kind                    | Location                                                                  | Trust                                                           |
| ----------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| First-party (bundled)   | repo-root `plugins/<name>/` → embedded in the app binary (`include_dir!`) | `builtin` — trusted by location, ships inside the signed binary |
| Third-party (installed) | `<profile>/plugins/<name>/` in the app-data dir                           | `installed` — subject to the integrity gate below               |

Trust is decided **only by which directory a plugin was read from**, never by
anything inside its manifest. Dropping a copy of a built-in plugin into the
app-data dir loads it as a gated third-party plugin, so core plugins double as
worked examples.

## First-party plugins

These ship with the app (source under repo-root `plugins/`). Each documents
itself in-app via its manifest `descriptionKey`, shown in Settings → Plugins.

### Templates — `com.mindstream.templates.core`

Turns the user's own notes into reusable templates; there are no premade
templates. It contributes a **Template sources** settings section:

- **Template folder** (`source-folder`, a `folder` picker) — every markdown note
  inside the chosen folder (at any depth) becomes a template.
- **Template tag** (`source-tag`, a `tag` picker) — every markdown note carrying
  the chosen tag becomes a template.
- **Open new template notes** (`open-on-create`, a toggle).

It is a **scripted (`luau`) plugin**: it contributes a "New from template"
toolbar button (its own SVG icon) whose `main.luau` lists the matching notes
(`ms.notes` + the folder/tag settings) and, when one is picked, renders the
chosen note's title + body itself — the `{{…}}` engine lives in the plugin
(`renderTemplate`, split into `lib/template.luau` and loaded via `require`), so
`{{date}}`, `{{uuid}}`, filters, etc. are filled in by Luau. The app only
performs the resulting write (the script never writes notes itself). It holds
`notes.read` and `notes.create`. Disable the plugin to remove the button
entirely. Rendering runs in the backend, so user templates appear only in the
app, not the web build; the toolbar button is a desktop affordance, while the
command palette and mobile create menu offer the same templates.

## Manifest

```jsonc
{
  "manifestVersion": 1, // required; the manifest schema this plugin targets
  "minAppVersion": "0.2.0", // optional; refuse to load below this app version
  "id": "com.author.my-plugin", // stable, dotted, lowercase — the namespace for everything below
  "name": "My Plugin",
  "version": "1.0.0",
  "runtime": "manifest-only", // or "luau"
  "entry": "main.luau", // required iff runtime is "luau"; a plain .luau filename
  "limits": {
    "memoryBytes": 16777216,
    "timeoutMs": 500
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
version `1`; a manifest declaring a higher version is refused with "update the
app" rather than failing later on a field this version reads differently.

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
  _(your plugin)_. Each setting is stored at `plugins.<id>.<settingId>`.
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
  and currently supports `"format": "pdf"`.
- **`noteTemplates`** — declarative templates (`titleTemplate` / `bodyTemplate`
  with `{{…}}` placeholders, see below). Requires `templates.contribute`.
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
- **`toolbar`** (`runtime: "luau"` only) — buttons the plugin adds
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
| `notes.read`               | read vault metadata: `ms.notes` (titles, tags, folders — never bodies) and `ctx.folders`         |
| `notes.create`             | the app creates a note from the plugin's output. The app writes it, never the plugin             |
| `textCheckers.contribute`  | send note text to a network endpoint. The host makes the request; the plugin declares the format |
| `pluginStorage.read`       | read the plugin's own isolated data directory (`ms.storage.read` / `.list`)                      |
| `pluginStorage.write`      | write it (`ms.storage.write` / `.delete`)                                                        |
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

## Scripted plugins

Scripted plugins run in the Rust backend, never in the WebView. The app creates
a fresh runtime instance per call, bounds memory and execution time, exposes no
ambient filesystem/network authority, and installs host functions only when the
plugin's granted permissions allow them. Scripts return declarative data or
effects; the app performs all writes.

### Runtime limits

Scripted manifests may include optional resource limits:

```jsonc
"limits": {
  "memoryBytes": 134217728,
  "timeoutMs": 5000
}
```

The backend clamps these to host-owned minimums/maximums: memory to 1–64 MiB
(default 16 MiB) and the timeout to 50 ms – 5 s (default 500 ms). Raise the
timeout for a script that shells out to a slow native tool — subprocess
wall-time does not count against the script budget, but the script's own work
around it does.

## Luau plugins (`runtime: "luau"`)

A `luau` plugin ships one or more `.luau` files (an `entry` plus any modules it
`require`s — see below). The script runs in a **sandbox in the Rust backend**
(never the WebView): a fresh VM per call, Luau's curated stdlib (no `io`,
`os.execute`, `package`, or `ffi`; `require` is plugin-scoped), a memory cap, and
a wall-clock deadline. It cannot touch the filesystem, network, or other notes
except through the gated host API.

### Entry contract

The script evaluates to a table of functions (or a single bare function). The
app calls one exported function with a context table and expects a result table:

```lua
-- main.luau
return {
  render = function(ctx)
    return {
      title = "Meeting — " .. ms.date.now("YYYY-MM-DD"),
      body = ms.md.frontmatter({ type = "meeting", attendees = {} })
        .. "\n## Notes\n",
    }
  end,
}
```

For templates the app performs the note creation from the returned
`{ title, body }` — the script never writes notes itself. A `noteTemplate` opts
into this by setting `"render": "<export>"` instead of static
`titleTemplate`/`bodyTemplate`.

For note exporters, the app calls the named export with
`{ noteId, noteKind, title, body, format }` after the user explicitly chooses
that export for a note. The plugin returns bytes for the host to save:

```lua
return {
  exportPdf = function(ctx)
    return {
      file = {
        mime = "application/pdf",
        dataBase64 = "...",
        suggestedName = ctx.title .. ".pdf",
      },
    }
  end,
}
```

For compatibility with preview renderers, the host also accepts
`{ preview = { mime = "application/pdf", dataBase64 = "..." } }`. The app owns
the save dialog and file write; the script only returns data.

### Splitting a script across files

A plugin isn't limited to its single `entry` file. Any other `.luau` file it
bundles can be loaded with a **plugin-scoped `require`**, so you can factor logic
into modules:

```lua
-- main.luau
local parser = require("lib/parser") -- loads lib/parser.luau
return { render = parser.render }
```

`require(name)` resolves `name.luau` relative to the plugin root (`/`-separated
subpaths like `lib/parser` are fine); a module is evaluated once and its return
value cached. It resolves **only** the plugin's own bundled files — `..`,
absolute paths, the filesystem, and other plugins are all rejected — so it can't
reach outside the (signed) plugin bundle. There is no `package`/`io`/`os`.

### Effects (toolbar buttons)

A toolbar button's export is called with the context table and returns a
**declarative effect** — a closed set the app performs on the script's behalf
(the "plugin computes, app acts" rule). The script never touches the DOM:

| Effect                                                         | Does                                             |
| -------------------------------------------------------------- | ------------------------------------------------ |
| `{ effect = "none" }`                                          | nothing                                          |
| `{ effect = "toast", message, kind? }`                         | show a toast (`kind` `"info"`\|`"error"`)        |
| `{ effect = "createNote", title, body, parentId? }`            | create + open a note (needs `notes.create`)      |
| `{ effect = "createNoteFromNote", sourceNoteId, parentId? }`   | copy a source note (interpolated) into a new one |
| `{ effect = "insertMarkdown", markdown }`                      | insert markdown at the active note's cursor      |
| `{ effect = "openMenu", items = {{ label, run = <effect> }} }` | show a menu; each item runs its nested effect    |

Returning a terminal effect makes the button a single action; returning
`openMenu` makes it a sub-menu. The button's `ctx` carries `{ settings, folders,
activeNoteId, locale, now }`; combined with `ms.notes` (metadata, gated by
`notes.read`) a script can enumerate/filter notes itself — e.g. the Templates
plugin lists the notes in its configured folder/tag and returns a menu of
`createNoteFromNote`.

### Host API (`ms.*`)

Always available (pure, no permission):

| API                                             | Description                                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ms.log(msg)`                                   | write a line to the app log                                                                          |
| `ms.uuid()`                                     | a fresh v4 UUID string                                                                               |
| `ms.date.now(format?, offsetDays?, locale?)`    | current local time, moment-style format (default `YYYY-MM-DD`); `locale` (e.g. `de`) localizes names |
| `ms.date.format(input, format?, locale?)`       | format an RFC3339 string or epoch seconds; `locale` localizes month/weekday names                    |
| `ms.date.add(input, amount, unit)`              | shift a date (`second\|minute\|hour\|day\|week\|month\|year`), returns RFC3339                       |
| `ms.json.encode(value)` / `ms.json.decode(str)` | table ⇄ JSON string                                                                                  |
| `ms.md.frontmatter(table)`                      | build a `---`-delimited YAML frontmatter block                                                       |

Gated by `notes.read`:

| API                | Description                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `ms.notes.all()`   | every note's metadata: `{ id, title, tags, kind, folder_id, folder_path, created, modified }` |
| `ms.notes.get(id)` | one note's metadata, or `nil`                                                                 |

`ms.notes` is a read-only **metadata** snapshot (no body). Namespaces only exist
when the matching permission is granted, so `ms.notes == nil` for a plugin
without `notes.read`.

Gated by `pluginStorage.read` / `pluginStorage.write`:

| API                            | Description                                                           |
| ------------------------------ | --------------------------------------------------------------------- |
| `ms.storage.read(path)`        | file contents, or `nil` when absent (`pluginStorage.read`)            |
| `ms.storage.list(path?)`       | `{ { name, isDir, sizeBytes } }`, sorted (`pluginStorage.read`)       |
| `ms.storage.write(path, text)` | write, creating parent dirs (`pluginStorage.write`)                   |
| `ms.storage.delete(path)`      | remove a file or tree; absent is not an error (`pluginStorage.write`) |

This is the plugin's **own** isolated data directory — one per plugin id,
chosen by the host, never named by the script. Paths are relative, with no
`..`, no absolute paths and no symlink escape, and a single file is capped at
4 MiB. The two halves are separate grants, so a plugin that only needs to
remember something between runs can ask for `read` and get `read`/`list` with
no `write` in its namespace at all.

Reading a file that does not exist returns `nil` rather than erroring —
"have I stored this yet?" is the common first call and should not need a
`pcall`.

```lua
local storage = assert(ms.storage)
local seen = storage.read and storage.read("seen.json")
local state = seen and ms.json.decode(seen) or { count = 0 }
state.count += 1
if storage.write then storage.write("seen.json", ms.json.encode(state)) end
```

Gated by `nativeTools.runDeclared`:

| API                                    | Description                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `ms.nativeTools.available(toolId)`     | whether a declared tool (`contributes.nativeTools[].id`) was resolved on PATH      |
| `ms.nativeTools.run(toolId, options?)` | run a declared, available tool; returns `{ statusCode, stdout, stderr, timedOut }` |

`options` is
`{ args = { string }?, stdin = string?, timeoutMs = number?, outputBase64 = boolean? }`.
The host resolves the binary from PATH itself (never the script) and launches it
**directly** — no shell, no arbitrary paths — so a script can only run the exact
binaries its manifest declared under `contributes.nativeTools`. Native tools are
**desktop-only**: on mobile every declared tool reports unavailable, so always
guard with `available` before `run`. The subprocess wall-time does **not** count
against the script's Luau budget, so a slow compile won't trip the deadline.

For binary tools (PDF/PNG/…) set `outputBase64 = true`: `stdout` is then empty
and the raw bytes come back as `stdoutBase64` (raw stdout would not be valid
UTF-8). `stderr` is always exposed lossily for diagnostics.

A note kind can declare `render.requiresNativeTool = "<toolId>"`: the host checks
that tool up front and, when it's missing (not installed, or mobile), shows the
editor **source-only** instead of calling the renderer. A `render.previewMime` of
`application/pdf` makes the host render the returned `preview.dataBase64` with a
built-in PDF page viewer. See the bundled `typst` plugin, whose
`renderDocument` pipes the note body through the native `typst` binary
(`typst compile --format pdf - -`) and returns the PDF as base64 — one stream for
all pages (typst refuses multi-page SVG/PNG to stdout).

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

### Editor setup & type checking

Scripts run untyped inside the sandbox, but while you write one you can get full
type-checking and autocomplete for the returned effects and the whole `ms.*`
API. The app ships a single Luau definition file —
[`plugins/host.d.luau`](../plugins/host.d.luau) — that declares the `ms` global.
It is the **one shared type file every plugin uses**, in this repo and in your
own plugin projects; nothing is generated per plugin.

It works in any editor backed by
[luau-lsp](https://github.com/JohnnyMorganz/luau-lsp) (VS Code, RustRover /
IntelliJ, Zed, Neovim, …). Because `ms` is a global the host **injects** at
runtime rather than something you `require`, luau-lsp can only learn it from a
**definition file**: there is no in-source `import` for it, and the sandbox has
no `require`, so don't add one — it would crash at runtime.

1. **Copy `host.d.luau`** into your plugin project (take it from the version of
   the app you target).

2. **Add a `.luaurc`** next to your `.luau` files so the analyzer runs strict:

   ```json
   { "languageMode": "strict", "lint": { "*": true } }
   ```

3. **Point luau-lsp at the definition file** — the one editor-specific step (the
   same line the app repo commits for its own plugins):
   - **VS Code** (`johnnymorganz.luau-lsp`) — `.vscode/settings.json`:
     ```json
     {
       "luau-lsp.platform.type": "standard",
       "luau-lsp.types.definitionFiles": ["host.d.luau"]
     }
     ```
   - **RustRover / IntelliJ** (`intellij-luau`) — in **Settings → Languages &
     Frameworks → Luau**, add the definition file, or pass
     `--definitions=host.d.luau` to the LSP command.
   - **Zed / Neovim** — set the same `luau-lsp.types.definitionFiles` init option
     in your luau-lsp config.

   Your script is then checked end to end (`ctx`, effects, and `ms.*`):

   ```luau
   --!strict
   local function render(ctx)
     local notes = assert(ms.notes) -- present because the manifest grants notes.read
     local source = notes.get(ctx.settings.source)
     return { title = source and source.title or "Untitled", body = "" }
   end
   return { render = render }
   ```

**Zero-config fallback.** If you would rather not touch editor settings at all,
declare `ms` in `.luaurc` `globals` instead of loading the definition file:

```json
{ "languageMode": "strict", "globals": ["ms"] }
```

luau-lsp auto-discovers `.luaurc` in every editor, so this silences the
`Unknown global 'ms'` error with **no** per-editor setup — but it types `ms` as
`any`, so you lose autocomplete and `ms.*` checking. Use the definition file for
the full experience; use `globals` when you just want the error gone. (Pick one:
listing `ms` in `globals` while also loading the definition file double-declares
it.)

### Templater-style workflow

This host API covers the core of an Obsidian-Templater workflow with general
primitives: dates (`ms.date`), file/note metadata (`ms.notes`), frontmatter
(`ms.md`), and serialization (`ms.json`). What is intentionally **not** provided
yet:

- **Interactive prompts** (`tp.system.prompt` / `suggester`) — a mid-script UI
  round-trip conflicts with the wall-clock deadline. Collect inputs up front and
  pass them into the script's `ctx` instead.
- **Web requests** — would need a dedicated `net` permission and async host.
- **Note body / include** — the snapshot is metadata-only for now.

## Signing (third-party plugins)

Signing proves authorship and lets a plugin's own updates auto-approve instead
of re-prompting. A signed plugin ships `signature.json` next to `manifest.json`:
an Ed25519 signature over the plugin's **package digest** (a content hash of
every file, so the signature covers `.luau` files, docs and icons — not just the
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
