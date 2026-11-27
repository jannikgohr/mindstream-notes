# Known limitations: implementation notes

The code behind each entry in [Known limitations](../known-limitations.md),
plus the limitations only people working on the code run into. Each entry
says whether it is **by design**, a **known limitation** or **planned**, and
points at the code that owns the behaviour, so a by-design trade-off is not
"fixed" by accident.

The end-to-end coverage for these surfaces is laid out in the
[test strategy](e2e/strategy.md) and catalogued in the
[test flows](e2e/flows.md). To run the suites, see
[e2e-tests/README.md](../../e2e-tests/README.md).

---

## Note history & version restore

### Restore is not transactional under live collaboration — _known limitation_

A version restore is expressed as a **destructive "clear-all + re-add" of fresh
CRDT ops** on the shared document, the same way for every note kind that is
co-edited live:

| Kind     | Restore mechanism                                                | File                         |
| -------- | ---------------------------------------------------------------- | ---------------------------- |
| Markdown | `collabService.applyTemplate` replaces the whole doc             | `NoteEditor.svelte`          |
| Freeform | `replaceSceneInYDoc` deletes every key then re-sets the snapshot | `freeform/excalidraw-yjs.ts` |
| PDF      | `yDoc.transact(replace…, HISTORY_RESTORE_ORIGIN)`                | `PdfNoteViewer.svelte`       |
| Ink      | `doc.clearAll()` + `doc.addStrokes(snapshot)`                    | `InkWebNoteEditor.svelte`    |
| Kanban   | `writeBoardToYDoc(…, KANBAN_RESTORE_ORIGIN)` rewrites the board  | `KanbanNoteEditor.svelte`    |

Plugin documents such as Typst are not co-edited live. Their restore replaces
the source text and saves it (`PluginDocumentNoteEditor.svelte`), so this
limitation does not apply to them.

Because it mutates the shared Yjs doc, the restore propagates live to every
connected peer — that part is intended. The limitation is the **merge
semantics**: a restore is roughly _last-writer-wins at whole-document scope_,
resolved per-field by the CRDT. Concretely:

- A collaborator's element/stroke added concurrently (not yet seen by the
  restorer) is **not** in the restorer's delete set, so it survives the restore
  as an orphan — you get the restored scene _plus_ stray content.
- For markdown, a paused/disconnected peer's concurrent text edit **survives**
  the restore the same way: the restore only deletes the range the restorer
  diffed (`minimalDocDiff`), and an unseen concurrent insert was never in it.
  You get the restored body _plus_ that edit.

It always converges (no divergence/corruption), but it is not a clean
transactional swap.

A restore asks for confirmation when other people are connected
(`peerCount()` on the `NoteHistoryApi` bridge in `note-history-bridge.svelte.ts`,
checked in `NoteHistorySection.applyRestore`). Only markdown (`NoteEditor`) and
PDF (`PdfNoteViewer`) register `peerCount` so far. Kanban, ink and freeform fall
back to `0` and restore over collaborators without asking. Kanban uses the same
`CollabProvider` as markdown and only has to register it; ink and freeform need
presence plumbed from `InkWebCollabProvider` and `ExcalidrawRoomClient` into the
bridge. This is _planned_.

### History is per-device, not synced — _by design_

The `note_versions` table is **local and never synced** (see the
module header in `src-tauri/storage-core/src/history.rs`). A restore re-expresses content
as new ops, so the _content_ converges across devices — but the **timeline**
(the `reverted` entries, the pre-restore checkpoints, the Undo affordance)
exists only on the device that performed the action. A second device sees only
that the content changed.

Implication: do not promise a global "this note was restored on {date} by
{user}" audit trail. There isn't one, by design.

### The "Undo restore" affordance is local and ephemeral — _by design_

After a restore, the one-click Undo is held in the per-note bridge store
(`note-history-bridge.svelte.ts`, `noteRestoreUndo`) on the device that
restored. It is not synced, and it is cleared on app reload. It persists across
panel remounts (so a tree/sync refresh a few seconds after the restore's save
doesn't wipe it mid-view), but it is not durable state. Undo itself re-applies
the pre-restore body as another normal restore, so it is collab- and sync-safe.

### Binary checkpoint does a UI-thread encode on explicit restore — _known limitation_

The frequent **automatic** history capture for freeform/ink/PDF runs off the
UI thread (the backend reads saved `yrs_state` via
`capture_current_note_version`). But the **pre-restore checkpoint and the Undo
payload** come from `bridge.currentSnapshot()`, which encodes the live Yjs doc
on the UI thread. This runs only on an explicit user restore (infrequent), not
the hot autosave path — but a very large canvas may show a brief hitch at the
moment of restore.

### Editor undo never reverts a restore — _by design_

`Ctrl+Z` reverts only granular edits (a keystroke, a stroke, an annotation). A
version restore is **never** placed on the editor's native undo stack on any
kind: markdown and freeform don't put it there; PDF uses `HISTORY_RESTORE_ORIGIN` which
the `UndoManager` doesn't track; ink calls `InkDocument.resetUndoHistory()`
after a restore. Undoing a restore goes through History / the Undo affordance,
not `Ctrl+Z`. Documented here so it isn't "fixed" back into the undo stack.

---

## Sync & sharing

### A remote delete never destroys an unpushed local edit — _by design_

When a pull delivers a tombstone for a row that has unpushed local edits
(`dirty = 1`), the sync does **not** delete it. Instead it _detaches_ the row —
drops its link to the copy on the server but keeps the row and
its edits — and lets the next push re-home it (`apply_remote_delete` in
`src-tauri/src/sync/claim.rs`). Two consequences, both intentional:

- **Re-home is non-destructive.** Sharing a folder tombstones its items out of
  the vault and recreates them in a scope collection. A device holding an offline
  edit detaches its vault copy on the tombstone, then the scope pull reclaims the
  same row by stable `id` and CRDT-merges the edit in. The sync runs in
  pull → scope → push phases so the reclaim happens before the vault push, which
  otherwise would resurrect the detached row as an orphan.
- **Edit wins over delete.** A genuine "B deletes note N while A edited it
  offline" conflict resolves by **resurrecting** A's edited copy, not by honouring
  the delete. This is the safe default (never silently lose unpushed work), but it
  means a delete is not guaranteed to stick if another device was concurrently
  editing offline. There is no way to distinguish "I meant to delete" from a
  re-home at the receiving end.

A **clean** (non-dirty) row is still a real delete, with one exception: a clean
**asset** that a note on this device still shows, from its body or the live part
of its Yjs state, is kept and re-uploaded the same way (`note_still_drawing` in
`src-tauri/src/sync/claim.rs`). The device that sent the delete judged from its
own copy of the note, which can lag. History doesn't count as a reference here:
it is per-device, and counting it would bring back images that were removed on
purpose. A device on an older version that keeps deleting such an asset gets it
re-uploaded after each of its deletes until it updates. **Signatures** are
excluded — they hard-delete on a tombstone regardless of dirty state.

Known asymmetry: note bodies are CRDT-merged, but note/folder _metadata_
(title, parent, trash, rename) is last-write-wins — preserved when dirty, but
not merged. A concurrent offline rename on two devices resolves last-writer-wins,
not by combining.

### A note's rendered body can lag its content after concurrent edits — _known limitation_

When two devices edit a Markdown note offline, the merged Yjs state is right but
`notes.body` keeps one device's rendering until an editor saves the note again.
Search and previews read `body`; attachment checks also read the live Yjs state.
The rules and why Rust can't re-render are in
[markdown-editor.md](markdown-editor.md#sync-and-a-lagging-body).

### Demo notes can duplicate across app versions and can't be shared — _by design_

A demo note (the welcome content setup can add) is named after the document it
starts from: `demo_<slug>_<lang>_<hash>`, where the hash covers its title and
encoded Yjs state (`src-tauri/src/demo_notes.rs`). Devices holding the same id
started from identical bytes, so sync merges their edits like any note's and
nothing is lost. Two consequences:

- **Duplicates across versions.** Two devices set up on app versions whose demo
  text or editor renders differently get two different notes. That is the cost
  of never rewriting an existing note: an app update only changes what new
  setups create.
- **No sharing.** Sync matches notes by id, so another person holding the same
  demo note could not take in a shared copy. Moving a demo note into a shared
  folder, or sharing a folder that holds one, is refused with a message;
  copying the text into a new note works.

An unedited demo note also stays on its device (`dirty = 0`) until it changes.

## Persistence & backend

### Single SQLite connection behind one mutex — _known limitation_

The whole app shares one `Mutex<Connection>` (`src-tauri/src/db/mod.rs`). History
capture does its CPU-heavy work (decompress / diff / compress / base64)
**off** that lock — read the dedup baseline under the lock, compute released,
re-acquire only to insert — but every DB operation still serializes on that one
connection. High-throughput workloads (vault scans, batch imports) can contend.
The module header documents the upgrade path (writer thread or `r2d2_sqlite`
pool) if this ever becomes a bottleneck.

---

## Import

The user-facing entries are in
[Known limitations](../known-limitations.md#import). Where each one lives:

- **Evernote links matched by title:** `rewrite_evernote_links` in
  `src-tauri/storage-core/src/import/links.rs`.
- **Obsidian note embeds become plain links:** the wikilink rewrite in
  `src-tauri/storage-core/src/import/links.rs`. **Canvas and Excalidraw files**
  are not Markdown, so the vault source never picks them up.
- **Older duplicate attachments are not merged:** `idx_assets_scope_hash` is
  deliberately not unique, because merging would mean rewriting
  `asset:mindstream/<id>` URLs in note bodies from inside a migration (see the
  comment above it in `src-tauri/storage-core/src/migrations.rs`).
- **Title links pick the most recently edited note:** `resolveNoteIdByTitle` in
  `src/lib/editor/plugins/prose/wikilink/note-resolve.ts`, deprecated. It can go
  once **Convert legacy links** (`src-tauri/src/import/legacy_links.rs`) has run.
