# Known limitations

Behaviours that are **intentional trade-offs or not-yet-implemented**, grouped
by area. This is the place to look before filing "bug: restore lost my
collaborator's edit" — several of these are by design and have a documented
reason. Each entry notes whether it's **by design**, a **known limitation**, or
**planned**, and points at the code that owns the behaviour.

The end-to-end coverage for these surfaces (and the planned fixes) is laid out
in [e2e/strategy.md](e2e/strategy.md) and catalogued in
[e2e/flows.md](e2e/flows.md). To run the suites, see
[e2e-tests/README.md](../e2e-tests/README.md).

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
- For markdown, a paused/disconnected peer's concurrent text edit **survives**
  the restore the same way: the restore only deletes the range the restorer
  diffed (`minimalDocDiff`), and an unseen concurrent insert was never in it.
  You get the restored body _plus_ that edit. This used to clobber the peer's
  text, back when a restore replaced the whole document; narrowing it to a
  minimal diff stopped a restore from silently destroying a collaborator's
  typing. Connected peers still get a warning prompt before a restore.

It always converges (no divergence/corruption), but it is not a clean
transactional swap. The **collab confirmation prompt** (see below) mitigates the
connected-peer case by warning before overwriting a note others are editing.

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

## Sync & sharing

### A remote delete never destroys an unpushed local edit — _by design_

When a pull delivers a tombstone for a row that has unpushed local edits
(`dirty = 1`), the sync does **not** delete it. Instead it _detaches_ the row —
drops the server identity (`etebase_uid`/`etebase_etag`) but keeps the row and
its edits — and lets the next push re-home it (`apply_remote_delete` in
`src-tauri/src/sync/mod.rs`). Two consequences, both intentional:

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

A **clean** (non-dirty) row is still a real delete. **Signatures** are excluded —
they hard-delete on a tombstone regardless of dirty state.

Known asymmetry: note bodies are CRDT-merged, but note/folder _metadata_
(title, parent, trash, rename) is last-write-wins — preserved when dirty, but
not merged. A concurrent offline rename on two devices resolves last-writer-wins,
not by combining.

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

### Single SQLite connection behind one mutex — _known limitation (pre-existing)_

The whole app shares one `Mutex<Connection>` (`src-tauri/src/db/mod.rs`). History
capture now does its CPU-heavy work (decompress / diff / compress / base64)
**off** that lock — read the dedup baseline under the lock, compute released,
re-acquire only to insert — but every DB operation still serializes on that one
connection. High-throughput workloads (vault scans, batch imports) can contend.
The module header documents the upgrade path (writer thread or `r2d2_sqlite`
pool) if this ever becomes a bottleneck.

---

## Import

The importer and its format mapping are described in [import.md](import.md).

### Evernote links between notes are matched by title — _known limitation_

Evernote writes note links as `evernote:///view/<user>/<shard>/<guid>/<guid>/`,
but most `.enex` exports leave out the `<guid>` element on the notes
themselves, so the guid in a link usually has nothing to match. The importer
falls back to the link text, which Evernote fills with the target's title
(`rewrite_evernote_links` in `src-tauri/src/import/links.rs`). Two notes with
the same title can be confused. Exports that do carry guids resolve exactly. A
link that matches nothing keeps its text and loses the dead `evernote:` URL.

### Obsidian note embeds become plain links — _by design_

`![[Some note]]` shows one note inside another in Obsidian. Mindstream has no
equivalent, so the embed becomes an ordinary link to the same note. Image and
file embeds (`![[diagram.png]]`) are imported as attachments as expected.

### Canvas and Excalidraw files are not imported as drawings — _planned_

Obsidian `.canvas` files and the Excalidraw plugin's drawings are skipped. They
could map onto the freeform note kind, which uses Excalidraw, but that mapping
has not been written.

### Existing duplicate attachments are not merged — _by design_

Attachments are stored by content hash since migration 26, so new uploads and
imports reuse identical bytes. Duplicates already in a vault before that stay
as separate rows: merging them would mean rewriting the `asset:mindstream/<id>`
URLs inside note bodies from within a database migration. The dedup index is
deliberately not unique for the same reason (`src-tauri/src/db/migrations.rs`).

### Title-resolved `[[wikilinks]]` still work until converted — _deprecated_

Bodies written before note links carried ids can contain a bare `[[Title]]`,
which the editor resolves by title when clicked (`resolveNoteIdByTitle`, now
deprecated). On a title collision it picks the most recently modified note, so
the target can change as titles are edited. **Settings → Data → Maintenance →
Convert legacy links** rewrites them as id-based links; the runtime fallback can
be removed once that has run. Links whose title matches no note are left as
written.

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

### Concurrent vault platform checks

Ordinary desktop launches use the coordinator and isolated vault workers.
Root/vault settings, browser isolation, live ownership, remembered opening
choices, handoff, shortcuts, tray, autostart, Quit and update recovery are
implemented. Isolated test devices and mobile retain their single-vault flows.
Handoff may replace the native window while preserving its content and geometry.

Global plugin packages, theme presets and settings/plugin-data backup portability
are implemented. Credentials and downloaded caches stay device-local. Current
contracts are in [storage ownership and recovery](storage-ownership-and-recovery.md),
[plugin usage](plugins.md), [theming](theming.md) and
[backup portability](backup-restore-portability.md).

Linux compositor behavior and geometry constraints are recorded in
[the harness guide](e2e/harness.md#concurrent-vault-checks). The
[Ubuntu VM report](e2e/ubuntu-vm-qa.md) records passing Linux guest hard-reset
checks on ext4, packaged installation and updater restart using a disposable QA
signing key, real backup pickers and integer 200% scaling.

Remaining release QA:

- Windows directory-entry and physical host power-loss durability.
- Production-key updater installation and packaged restart on Windows/macOS.
- Real monitor, DPI and display-change behavior.
- Packaged macOS 14+ Dock/menu/Reopen, focus, hide/show and Cmd+Q behavior.
  The owner accepted deferral until a Mac is available for release testing.
