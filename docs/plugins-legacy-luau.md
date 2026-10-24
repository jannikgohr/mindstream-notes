# Legacy Luau plugins

Luau is retained temporarily while the Wasm migration completes its platform
gates. New plugins should use [TypeScript/Wasm](plugins.md#typescript-plugins).
Manifest version 1 accepts Luau; version 2 refuses it. The old bundled Luau
sources remain for migration regression tests and will be removed with M6.

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

### Editor setup & type checking

Scripts run untyped inside the sandbox, but while you write one you can get full
type-checking and autocomplete for the returned effects and the whole `ms.*`
API. The app ships a single Luau definition file —
[`host.d.luau`](../plugin-sdk/examples/legacy-luau/host.d.luau) — that declares the `ms` global.
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
