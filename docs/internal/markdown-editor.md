# The Markdown note editor and what depends on it

The Markdown note editor is Crepe (Milkdown on ProseMirror), bound to a Yjs
document through `y-prosemirror` (`src/lib/components/NoteEditor.svelte`,
`src/lib/editor/crepe-setup.ts`). Much of the app reads a Markdown note
without opening it in that editor. This page lists those places and the rules
they rely on, so that replacing or reworking the editor doesn't break them.

## Two copies of every Markdown note

Each Markdown note is stored twice in its `notes` row:

- **`yrs_state`**: the Yjs document. The editor's content lives in the
  `prosemirror` XML fragment. This is the source of truth: the editor opens it,
  live editing exchanges it, and sync merges it (`yrs_doc::merge_remote`).
- **`body`**: the note rendered as Markdown text. Search, exports, backlinks,
  templates and attachment bookkeeping read this copy.

`payload_schema` says which shape `yrs_state` has. Schema 2 is the editor's
fragment. Schema 1 is the older plain `body` Y.Text, which Rust can turn into
Markdown itself (`yrs_doc::to_markdown`).

**Only a live Milkdown instance can turn a schema 2 document into Markdown.**
Rust has no renderer for the fragment. The editor does it with Milkdown's
serializer (`getMarkdown` in `NoteEditor.svelte`, from `serializerCtx`). So
`body` is only as fresh as the last save from an open editor.

## Where Yjs becomes Markdown

The editor writes `body` in these places only:

- **Saving.** `currentNoteSaveInput` in `NoteEditor.svelte` sends the serialized
  Markdown together with `Y.encodeStateAsUpdate(yDoc)`. The backend stores both
  and stamps schema 2 (`notes::update` in `src-tauri/storage-core/src/notes.rs`).
- **Version history.** Markdown note versions hold the serialized Markdown
  (`captureHistoryMarkdown`), not Yjs bytes.
- **Source mode.** The CodeMirror mirror is filled from the serializer and
  written back through `applyTemplate` (`src/lib/editor/source/`).

Nothing re-renders `body` after a pull. When `sync-completed` reports a pulled
note that is open, `handleSyncCompleted` merges the new state into the live
document with the `REMOTE_SYNC_ORIGIN` origin, and the update handler skips the
save for that origin so the update doesn't bounce back to the other device. So
`body` keeps whatever the pull wrote until the next local edit.

## Where Markdown becomes Yjs

Each of these parses Markdown with the editor's own parser:

- **First open.** A note created with only a body (tray and global-shortcut
  templates, plugins, the importer, `create` with a body) has an empty fragment.
  The editor seeds it from `body` with a fixed client id
  (`seedDeterministicTemplate` in `src/lib/editor/seed-template.ts`), so devices
  that seed independently converge rather than duplicating the text.
- **Demo notes** (`src/lib/onboarding/demo-notes.ts`) build their state up
  front with the same fixed origin.
- **Inserting a snippet** at the caret (`src/lib/editor/insert-markdown.ts`):
  the command palette's **Insert template into note** and plugin effects.
- **Restoring a version** and leaving source mode go through `applyTemplate`.

On the Rust side, `yrs_doc::init_seed_state` and `init_with_markdown` build
**schema 1** documents. A save that sends a body without `yrs_state` (the
legacy-link conversion in `src-tauri/src/import/legacy_links.rs`, the browser
fallback) diffs the text into a schema 1 Y.Text and **downgrades the note to
schema 1**. The editor then has no fragment to open and seeds from `body`
again. Anything that edits a Markdown note's text outside the editor goes
through this path today.

## What reads `body`

None of these open the editor. They all trust `body`:

| Reader                                   | Where                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| Full-text search index                   | `note_search_*` triggers in `src-tauri/storage-core/src/migrations.rs`       |
| Search snippets in the frontend fallback | `src/lib/api/search-matcher.ts`                                              |
| Backlinks and note relations             | `src/lib/notes/note-relations.ts`                                            |
| Outline in the note sidebar              | `src/lib/components/NoteSidebar.svelte`                                      |
| Markdown, document and PDF export        | `src/lib/note-exporters/`, `src/lib/notes-export/index.ts`                   |
| User templates (a template is a note)    | `src/lib/templates/user-templates.ts`, `src/lib/plugins/templates.ts`        |
| Attachment references                    | `register_body_refs` and the sweep in `src-tauri/storage-core/src/assets.rs` |
| Sync upload                              | `push.rs` sends `body` beside `yrs_state` in every note payload              |

## Sync and a lagging `body`

A pull merges `yrs_state` but has to take one device's `body`, because nothing
on the receiving side can render the merged fragment (`apply_note_payload` in
`src-tauri/src/sync/apply/notes.rs`). A row with unpushed content keeps its own
rendering, and every other row takes the incoming one. Whether a dirty row
really has unpushed content is checked with `yrs_doc::contains_state`, because
a server switch marks every row dirty (`auth::reset_sync_cursors`).

When two devices both edited a note offline, neither rendering matches the
merged document, and `body` stays behind until an editor saves the note. In
November 2026 a lagging body lost a note's GIF: a device that signed in to a
new server second pushed a weeks-old rendering, and its attachment sweep freed
an image the merged document still showed. Since then, anything that decides
whether an attachment is in use also reads the live Yjs content
(`yrs_doc::live_strings`), and a remote delete of an attachment a note still
shows is refused. The details are under "A note's rendered body can lag its
content" in [known limitations](limitations.md).

## Other Milkdown instances

These render Markdown without being the note editor. A rework has to keep their
output consistent with it:

- `src/lib/components/history/ReadonlyNoteView.svelte` and
  `MilkdownDiffView.svelte`: read-only Crepe for the version history dialog.
- `src/lib/kanban/description-markdown.ts`: one detached Milkdown editor with
  only the CommonMark preset, turning Kanban card descriptions into HTML.
- `src/lib/onboarding/PracticeEditor.svelte`: the editor in first-run setup.

## What a replacement editor must provide

- A Markdown serializer that runs **without a mounted editor** and gives the
  same output as the editor. Without one, `body` can't be refreshed after a
  merge, and the lag described above stays.
- The same Yjs layout (`prosemirror` fragment, element attributes for node
  attributes such as an image's `src`), or a migration for every stored
  `yrs_state`, every version in history, and every device still on an old app.
- Attachment links as `asset:mindstream/<id>` in one attribute value. The
  sweep's byte pre-check and `live_strings` rely on a link never being split
  across typed characters.
- Seeding from Markdown with a fixed client id, so independently seeded copies
  of one note merge cleanly.
- An answer for body-only writers. Either they keep producing schema 1, or they
  get a way to edit the fragment directly.
