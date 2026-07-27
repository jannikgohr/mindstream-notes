# Plugins

Mindstream Notes has a small plugin system. A plugin is a folder with a
`manifest.json` (and, for scripted plugins, one `.luau` file). Plugins are
**data-first**: most extend the app declaratively, and only opt into a sandboxed
script when they need real logic.

## Where plugins live

| Kind                    | Location                                                                         | Trust                                                           |
| ----------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| First-party (bundled)   | repo-root `plugins/<name>/` → shipped in the app as the `core-plugins/` resource | `builtin` — trusted by location, ships in the signed app bundle |
| Third-party (installed) | `<profile>/plugins/<name>/` in the app-data dir                                  | `installed` — subject to the integrity gate below               |

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
toolbar button (its own SVG icon) whose `main.luau` lists the matching notes and
returns an `openMenu` of `createNoteFromNote` effects. The app copies the chosen
note's title + body through the `{{…}}` placeholder engine (so `{{date}}`,
`{{uuid}}`, etc. are filled in) and writes the new note — the script never
writes notes itself. It holds `notes.read` (to enumerate candidate notes) and
`notes.create`. Disable the plugin to remove the button entirely. (The button
runs only in the desktop app, since Luau is backend-only; the command palette
and mobile create menu list the same templates via the host.)

## Manifest

```jsonc
{
  "id": "com.author.my-plugin", // stable, dotted, lowercase — the namespace for everything below
  "name": "My Plugin",
  "version": "1.0.0",
  "runtime": "manifest-only", // or "luau"
  "entry": "main.luau", // required iff runtime is "luau"; a plain .luau filename
  "descriptionKey": "plugin.description", // optional i18n key; a short one-line tagline
  "permissions": [], // see Permissions
  "contributes": {
    /* … */
  }
}
```

Every runtime id derived from a plugin (settings keys, command ids, i18n keys)
is namespaced under the plugin `id`, so two plugins can never collide.

### Contributions

- **`i18n`** — `{ "<locale>": { "<key>": "<string>" } }`. An `en` bundle is
  required; other locales fall back to it. Referenced by `…Key` fields elsewhere.
- **`settings`** — sections of controls shown under Settings → Plugins →
  _(your plugin)_. Each setting is stored at `plugins.<id>.<settingId>`.
  Control `type`s: `toggle`, `text`, `number`, `slider`, `select`, `radio`,
  `color`, and the vault pickers **`folder`** and **`tag`** (their value is a
  folder id / tag string and auto-clears if the target is deleted).
- **`noteTemplates`** — declarative templates (`titleTemplate` / `bodyTemplate`
  with `{{…}}` placeholders, see below). Requires `templates.contribute`.
- **`commands`** — app-local commands (currently `createTemplateNote`), each
  bindable to a hotkey.
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
- **`toolbar`** (`runtime: "luau"` only) — buttons the plugin adds to a host
  toolbar (currently the file-tree toolbar). Each ships its own bundled `.svg`
  icon (rendered as a themed monochrome mask) and runs a Luau export on click:
  ```jsonc
  "toolbar": [{
    "id": "new-from-template",
    "location": "file-tree",
    "labelKey": "toolbar.newFromTemplate",   // plugin i18n key (tooltip)
    "icon": "icons/templates.svg",           // safe relative .svg path
    "action": { "type": "script", "export": "newFromTemplate" }
  }]
  ```
  The export returns a **declarative effect** the app performs (see below) — so
  one button is either a single action or a sub-menu, depending on what it
  returns.

### Placeholder syntax (declarative templates)

`titleTemplate` / `bodyTemplate` support `{{ base [offset] [:format] [|filter] }}`:

- built-in dates: `{{date}}`, `{{time}}`, `{{datetime}}`, `{{now}}`
- date math: `{{date+7d}}`, `{{date-1M:YYYY-MM-DD}}` (units `y M w d h m s`)
- formatting: `{{date:dddd}}`, `{{datetime:YYYY-MM-DD HH:mm}}` (moment-style tokens)
- `{{uuid}}`, and filters `|upper|lower|trim|capitalize|slug`

## Permissions

| Permission             | Grants                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `templates.contribute` | the plugin's templates appear in create menus                                           |
| `notes.create`         | the app creates a note from the plugin's template (the app writes it, never the plugin) |
| `notes.read`           | a `luau` script may read note metadata via `ms.notes`                                   |

A manifest is rejected if it contributes something it didn't ask permission for.
Each plugin's requested permissions are shown to the user (with friendly labels)
in Settings → Plugins, alongside its `descriptionKey` tagline and a "View
documentation" button that renders the `contributes.documentation` files
read-only.

## Scripted plugins (`runtime: "luau"`)

A `luau` plugin ships one Luau script (`entry`). The script runs in a **sandbox
in the Rust backend** (never the WebView): a fresh VM per call, Luau's curated
stdlib (no `io`, `os.execute`, `require`, or `ffi`), a memory cap, and a
wall-clock deadline. It cannot touch the filesystem, network, or other notes
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

| API                                             | Description                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `ms.log(msg)`                                   | write a line to the app log                                                    |
| `ms.uuid()`                                     | a fresh v4 UUID string                                                         |
| `ms.date.now(format?, offsetDays?)`             | current local time, moment-style format (default `YYYY-MM-DD`)                 |
| `ms.date.format(input, format?)`                | format an RFC3339 string or epoch seconds                                      |
| `ms.date.add(input, amount, unit)`              | shift a date (`second\|minute\|hour\|day\|week\|month\|year`), returns RFC3339 |
| `ms.json.encode(value)` / `ms.json.decode(str)` | table ⇄ JSON string                                                            |
| `ms.md.frontmatter(table)`                      | build a `---`-delimited YAML frontmatter block                                 |

Gated by `notes.read`:

| API                | Description                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `ms.notes.all()`   | every note's metadata: `{ id, title, tags, kind, folder_id, folder_path, created, modified }` |
| `ms.notes.get(id)` | one note's metadata, or `nil`                                                                 |

`ms.notes` is a read-only **metadata** snapshot (no body). Namespaces only exist
when the matching permission is granted, so `ms.notes == nil` for a plugin
without `notes.read`.

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
every file, so the signature covers the `.luau` code too — not just the
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
