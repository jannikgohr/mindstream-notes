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

Templates appear in the "New from template" menu (file-tree toolbar + mobile
FAB). Creating one copies the source note's title + body through the `{{…}}`
placeholder engine (so `{{date}}`, `{{uuid}}`, etc. are filled in) and the app
writes the new note. The plugin itself holds no permissions — the app owns the
note write and reads the two settings by convention. Disable the plugin to
remove the "New from template" affordance entirely.

## Manifest

```jsonc
{
  "id": "com.author.my-plugin", // stable, dotted, lowercase — the namespace for everything below
  "name": "My Plugin",
  "version": "1.0.0",
  "runtime": "manifest-only", // or "luau"
  "entry": "main.luau", // required iff runtime is "luau"; a plain .luau filename
  "descriptionKey": "plugin.description", // optional i18n key; shown to the user as the plugin's docs
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
`{ title, body }` — the script never writes notes itself.

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
