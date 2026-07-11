# Known limitations

Behaviours that are **intentional trade-offs or not-yet-implemented**, grouped
by area. This is the place to look before filing "bug: restore lost my
collaborator's edit" — several of these are by design and have a documented
reason. Each entry notes whether it's **by design**, a **known limitation**, or
**planned**, and points at the code that owns the behaviour.

The end-to-end coverage for these surfaces (and the planned fixes) is laid out
in [e2e-strategy.md](e2e-strategy.md) and catalogued in
[e2e-flows.md](e2e-flows.md).

---

## Note history & version restore

### Restore is not transactional under live collaboration — _known limitation_

A version restore is expressed as a **destructive "clear-all + re-add" of fresh
CRDT ops** on the shared document, identically for every note kind:

| Kind     | Restore mechanism                                                | File                         |
| -------- | ---------------------------------------------------------------- | ---------------------------- |
| Markdown | `collabService.applyTemplate` replaces the whole doc             | `NoteEditor.svelte`          |
| Freeform | `replaceSceneInYDoc` deletes every key then re-sets the snapshot | `freeform/excalidraw-yjs.ts` |
| PDF      | `yDoc.transact(replace…, HISTORY_RESTORE_ORIGIN)`                | `PdfNoteViewer.svelte`       |
| Ink      | `doc.clearAll()` + `doc.addStrokes(snapshot)`                    | `InkWebNoteEditor.svelte`    |

Because it mutates the shared Yjs doc, the restore propagates live to every
connected peer — that part is intended. The limitation is the **merge
semantics**: a restore is roughly _last-writer-wins at whole-document scope_,
resolved per-field by the CRDT. Concretely:

- A collaborator's element/stroke added concurrently (not yet seen by the
  restorer) is **not** in the restorer's delete set, so it survives the restore
  as an orphan — you get the restored scene _plus_ stray content.
- For markdown, replacing the entire document while a peer is typing produces a
  messy text merge at the edit boundaries.

It always converges (no divergence/corruption), but it is not a clean
transactional swap. The planned mitigation is the **collab confirmation prompt**
(see _Planned_ below), which warns before overwriting a note others are editing.

### History is per-device, not synced — _by design_

The `note_versions` table is **local and never pushed through Etebase** (see the
module header in `src-tauri/src/history/mod.rs`). A restore re-expresses content
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

The frequent **automatic** history capture for freeform/ink/PDF was moved off
the UI thread (the backend reads saved `yrs_state` via
`capture_current_note_version`). But the **pre-restore checkpoint and the Undo
payload** come from `bridge.currentSnapshot()`, which encodes the live Yjs doc
on the UI thread. This runs only on an explicit user restore (infrequent), not
the hot autosave path — but a very large canvas may show a brief hitch at the
moment of restore.

### Editor undo never reverts a restore — _by design (consistency fix)_

`Ctrl+Z` reverts only granular edits (a keystroke, a stroke, an annotation). A
version restore is **never** placed on the editor's native undo stack on any
kind — markdown and freeform never did; PDF uses `HISTORY_RESTORE_ORIGIN` which
the `UndoManager` doesn't track; ink calls `InkDocument.resetUndoHistory()`
after a restore. Undoing a restore goes through History / the Undo affordance,
not `Ctrl+Z`. Documented here so it isn't "fixed" back into the undo stack.

---

## Persistence & backend

### Single SQLite connection behind one mutex — _known limitation (pre-existing)_

The whole app shares one `Mutex<Connection>` (`src-tauri/src/db/mod.rs`). History
capture now does its CPU-heavy work (decompress / diff / compress / base64)
**off** that lock — read the dedup baseline under the lock, compute released,
re-acquire only to insert — but every DB operation still serializes on that one
connection. High-throughput workloads (vault scans, batch imports) can contend.
The module header documents the upgrade path (writer thread or `r2d2_sqlite`
pool) if this ever becomes a bottleneck.

---

## Planned / not yet implemented

### Collab confirmation prompt before restore — _partially implemented_

A restore overwrites the shared document for everyone connected. To make that
deliberate, the restore now shows a confirmation when other clients are present
(_"Other people are editing this note live. Restoring replaces the shared
content for everyone… Continue?"_), with solo editing left frictionless. It is
wired through an optional `peerCount()` method on the `NoteHistoryApi` bridge
(`note-history-bridge.svelte.ts`), checked in `NoteHistorySection.applyRestore`.

The remaining gap is **per-editor presence**. The three editors use three
different collab layers — `CollabProvider.awareness` (markdown/PDF),
`InkWebCollabProvider` (ink), `ExcalidrawRoomClient` (freeform) — and only the
awareness-based ones report a count today: markdown (`NoteEditor`) and PDF
(`PdfNoteViewer`) register `peerCount: () => otherPeerCount(awareness)`. Ink
(`InkWebNoteEditor`) and freeform (`FreeformNoteEditor`) do **not** register
`peerCount`, so for those two kinds the count falls back to `0` and a restore
still overwrites collaborators silently. Closing it means plumbing presence from
`InkWebCollabProvider` and `ExcalidrawRoomClient` into the bridge — which is why
the _non-transactional restore_ limitation above is still user-visible for ink
and freeform.

### User profiles / multi-vault — _planned_

Multi-vault profiles (`feat/user-profiles`, `src-tauri/src/profiles.rs`). The
active-profile seam (`MINDSTREAM_PROFILE_DIR` / `dir_override`, gated to dev
builds and the `e2e-data-dir` feature) already exists and is what e2e isolation
relies on; the lifecycle + UI are still in progress.
