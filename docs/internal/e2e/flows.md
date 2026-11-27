# End-to-end test flows

The flows worth an end-to-end test, and which spec covers each. Pick the tier
with [strategy.md](strategy.md); run the suites with the
[harness](harness.md) and the [test backend](backend-stack.md). Several flows
pin down by-design behaviour described in [limitations.md](../limitations.md).

Every flow below needs something the browser-fallback suite (T2) cannot give: a
real Rust backend, a real disk, a real network peer or a real restart. Each one
ends with the spec that covers it (**Covered**) or what is missing (**Open**).
Spec paths are relative to `e2e-tests/app/specs/` unless they start with
`browser/`. A spec that self-skips counts as open.

Priority: **P1** core, ship-blocking; **P2** important; **P3** nice to have.

---

## 1. Critical user journeys

The core workflows. If one of these breaks, the app is broken.

### 1.1 Create → edit → reopen a markdown note (P1)

- **Why e2e:** exercises the Milkdown/ProseMirror editor, the y-prosemirror
  CRDT, the `save_note` IPC and SQLite persistence, all excluded from unit
  coverage (`editor/**`, `api/notes.ts`, the `notes/mod.rs` command layer).
- **Steps:** launch app → create note → type rich content (heading, bold,
  list, code block) → switch to another note and back → assert the rendered
  content survives.
- **Proves:** the editor↔CRDT↔DB round-trip and that body/markdown
  serialisation is lossless.
- **Covered:** `single/editor-roundtrip.e2e.ts` (across reopen and restart);
  `browser/editor-roundtrip.spec.ts` for the UI half.

### 1.2 Export the vault to disk (P1)

- **Why e2e:** `backup_now` pops a native save dialog, `VACUUM INTO`s the live
  DB, zips it and writes atomically. The `run_backup` orchestration needs a
  real `AppHandle` and file system.
- **Steps:** seed a few notes/folders → **Settings → Data → Export vault** →
  choose a destination → assert a `.zip` is written and the result dialog
  reports the correct counts.
- **Proves:** the export chain end to end, including the manifest/counts the
  dialog builders (unit-tested in `export-result-dialog.svelte.test.ts`)
  render.
- **Open:** `single/backup.e2e.ts` is a stub that skips unless
  `MINDSTREAM_E2E_DIALOG_HOOK=1`; it needs a path-injection seam for the save
  and open pickers. `src-tauri/scripts/supervised-backup-check.py` covers the
  portable backup through the real Rust helpers in the meantime (see
  [harness.md](harness.md#concurrent-vault-checks)).

### 1.3 Import / restore a backup (P1)

- **Why e2e:** import opens a file picker, extracts into a staging dir, runs
  migrations on the staged DB, and for a restore stages a pending DB and
  relaunches. The restart half can only be verified by restarting.
- **Steps:** export a vault (1.2) → wipe/alter the live vault → **Import** the
  zip → choose _Restore_ → let the app relaunch → assert the imported
  notes/folders are present and the live DB was swapped.
- **Proves:** `import_begin` → `import_restore` → `apply_pending_restore_if_any`
  across a real restart.
- **Open:** as 1.2.

### 1.4 Import / merge a backup (P2)

- **Steps:** import a zip → choose _Merge_ → assert only rows whose ids don't
  already exist are added, orphaned parents are rerouted to root, and the
  merge-result dialog counts match.
- **Proves:** the in-process `merge_into` path wired through the real IPC and
  dialog (the SQL merge itself is unit-tested).
- **Open:** as 1.2.

### 1.5 Trash → restore → purge a note (P1)

- **Why e2e:** spans the tree store, the `trash_note`/`restore`/`purge` IPC,
  and the `trashed_at` column semantics across the Trash view.
- **Steps:** trash a note → confirm it leaves Home and appears under Trash →
  restore it → confirm it returns → trash again → purge → confirm it's gone.
- **Proves:** the soft-delete lifecycle and that `trashed_at` is set and
  cleared on every path.
- **Covered:** `single/trash-retention.e2e.ts`;
  `browser/tree-lifecycle.spec.ts` and `browser/tree-operations.spec.ts` for
  the UI half.

### 1.6 Ink / drawing note round-trip (P2)

- **Why e2e:** the ink canvas (`ink/editor-helpers.ts`) and the Excalidraw
  island (`freeform/**`) are pointer/canvas/React surfaces excluded from unit
  coverage; only the geometry and document model are unit-tested.
- **Steps:** create a drawing note → draw a few strokes → reopen → assert the
  strokes persist and render.
- **Proves:** stroke capture → Y.Doc encode → asset persistence → decode.
- **Open:** in the packaged app. `browser/ink-pdf.spec.ts` covers drawing and
  page management against the mock store.

---

## 2. IPC-heavy operations

A UI action that delegates to Rust to touch the OS, then renders the result.
The value is proving the whole frontend↔Rust↔frontend chain.

### 2.1 Tree hydration from the database (P1)

- **Why e2e:** `loadTree` calls `list_notes` and `list_collections` over IPC
  and assembles the tree. This proves the real Rust query and serialisation
  match what the UI expects.
- **Steps:** launch with a seeded DB → assert the file explorer renders the
  expected folder/note hierarchy with correct kinds/icons.
- **Proves:** the `notes`/`collections` read path and the
  `NoteSummary`/`TreeNode` wire contract.
- **Covered, in part:** `single/import-notes.e2e.ts` asserts an imported
  hierarchy in the tree, also after a restart. Note kinds and icons are not
  asserted.

### 2.2 PDF import → render → annotate → export (P2)

- **Why e2e:** `import_pdf_note` stores the binary as an app-owned asset,
  pdf.js renders it, and the export bakes annotations back in.
- **Steps:** import a PDF → assert pages render → add a highlight and a
  signature → export the annotated PDF → assert the output file exists and
  reopens.
- **Proves:** asset IPC, pdf.js rendering and the annotation→PDF pipeline.
- **Open:** in the packaged app, blocked on the picker seam (1.2).
  `browser/ink-pdf.spec.ts` and `browser/note-exports.spec.ts` cover import
  and export against the mock store.

### 2.3 Signature photo import → place → export (P2)

- **Why e2e:** photo signature import crosses surfaces unit tests cannot
  exercise: OS camera/file capture, `createImageBitmap`, real canvas
  rasterisation, live preview frames, pointer-driven crop handles, pdf.js
  placement and the annotated-PDF export.
- **Steps:** import a PDF → open the signature picker → **Import from photo**
  → use a picked image and, where available, the camera → toggle paper
  auto-crop → adjust the crop handles → save the signature → place it on the
  PDF → export → reopen the output and assert the transparent signature
  appears where it was placed.
- **Proves:** `signature-import-image.ts`, the `SignatureImportDialog.svelte`
  states, saved scanned signatures, placement in `PdfNoteViewer.svelte`, and
  the image path in `exportAnnotatedPdf`.
- **Open.**

### 2.4 Full-text search against the Rust matcher (P2)

- **Why e2e:** production search runs in Rust (`search/mod.rs`); the TS
  `search-matcher.ts` is only the browser-fallback mirror.
- **Steps:** seed notes → open search → type a query → assert the
  Rust-ranked results and highlight ranges.
- **Proves:** the two matchers stay aligned (AND semantics, scoring, snippet
  windows).
- **Open.** `browser/search.spec.ts` covers the mirror.

### 2.5 Open vault folder / reveal in OS file manager (P3)

- **Steps:** **Settings → Data → Open data folder** → assert the shell opens
  the correct path (intercept the shell call).
- **Proves:** the `open_data_folder`/`open_with_shell` command shims.
- **Open.**

### 2.6 Live collaboration between two windows (P3)

- **Why e2e:** the collab providers (`sync/collab-provider.ts`,
  `ink-web-collab-provider.ts`) and the room plumbing are network surfaces
  excluded from unit coverage.
- **Steps:** open the same note on two clients → type in one → assert the
  edit appears in the other; go offline → assert reconnect converges.
- **Proves:** the y-protocols transport, awareness and reconnection.
- **Covered:** `multi/collab.e2e.ts` for markdown notes, including restore,
  undo of a restore and offline edits on both sides.

### 2.7 macOS native menu and window chrome (P2)

- **Why e2e:** the native menu (`native_menu.rs`) and its frontend bridge
  (`native-menu.svelte.ts`) only mean something when Tauri owns the real macOS
  menu bar, focused windows, accelerators, Dock activation and decorations.
- **Steps:** launch the packaged macOS app → confirm native decorations are
  the default → toggle custom decorations and relaunch if required → use File
  menu commands to create each note kind and import a PDF → use Edit menu
  undo/redo/cut/copy/paste/select-all in markdown, ink/PDF and plain inputs →
  use View menu sidebar/metadata/search/theme commands → switch popouts from
  the Window menu → close the main window and reopen it from the Dock.
- **Proves:** menu ids route to the focused webview, commands enter the hotkey
  bus once, window chrome matches settings, and close/Dock/window switching
  behave natively.
- **Open:** needs a macOS runner.

### 2.8 Plugin artifact download → verify → use (P2)

- **Why e2e:** `plugins_artifact_status` / `_download` / `_remove`
  (`plugins/mod.rs`) are the app's only download-and-execute path. The digest
  check, size check, staged write and traversal-safe layout are Rust tests
  (`plugins::tests::artifacts`); the HTTPS transfer, the command layer and
  restart persistence need the real app.
- **Steps:** launch with a plugin declaring an artifact served by a local HTTPS
  stub → assert the artifact shows as missing → download → assert it reports
  installed with the declared size → relaunch → still installed → serve a
  corrupted body, remove and re-download → assert the download fails and no
  file is left behind.
- **Proves:** a real transfer reaches the gate, the panel reports what landed
  on disk, and installed state survives a restart.
- **Open, blocked:** the app refuses non-HTTPS URLs twice (`validation.ts` and
  `plugins/mod.rs`) and uses a default `reqwest` client, so a self-signed
  certificate fails. A seam that relaxes certificate checks would weaken the
  property under test, so it is not an option; the choices are downloading
  from upstream or a test certificate in the machine's trust store.

### 2.9 Native preview service + themed proxy (P2)

- **Why e2e:** `plugins_preview_start` / `_update` / `_stop`
  (`plugins/preview_service.rs`) spawn a child process, wait for its port and
  put a loopback proxy in front of it. The proxy internals are unit-tested over
  real sockets; the process lifecycle is not.
- **Steps:** launch with the Typst plugin and a stub service binary on PATH →
  open a plugin-owned note → assert the preview loads through the proxy origin
  → edit → assert it updates without a second process → close the note →
  assert the child is gone → repeat and quit mid-preview → assert no orphan
  survives.
- **Proves:** one session per note, the webview never talks to the service
  directly (the CSP depends on that), and no leaked child processes.
- **Open.**

---

## 3. State persistence across restart

Change something the app saves to disk, restart, check it stuck. The restart
is the proof.

### 3.1 Settings persist across restart (P1)

- **Why e2e:** binding-backed settings (theme, language, autostart, tray) are
  written through `desktop_settings` IPC to disk and the OS.
- **Steps:** change theme to Dark, language to German and toggle "close to
  tray" → quit → relaunch → assert all three are remembered.
- **Proves:** the `set_desktop_setting`/`get_desktop_setting` round-trip and
  the startup hydration in `settings/store.svelte.ts`.
- **Covered, in part:** `single/settings-persist.e2e.ts` asserts the theme.
  Language and close to tray are open.

### 3.2 Sidebar / sort UI preferences persist (P2)

- **Steps:** collapse a sidebar, resize it, change the sort strategy and
  direction → relaunch → assert the layout is restored.
- **Proves:** the debounced save in `preferences.ts` and rehydration into `ui`
  state (`state.svelte.ts`).
- **Open:** a TODO in `single/settings-persist.e2e.ts`.

### 3.3 Trash retention sweep on startup (P2)

- **Why e2e:** `spawn_retention_sweep` runs on boot and purges trashed items
  older than the retention window.
- **Steps:** trash an item and back-date its `trashed_at` past the window →
  relaunch → assert it was purged; trash a fresh item → relaunch → assert it
  survived.
- **Proves:** the retention scheduler and the `sweep` cascade (the SQL is
  unit-tested; the boot wiring is not).
- **Covered, in part:** `single/trash-retention.e2e.ts` asserts the fresh item
  survives. The purge needs a hook to back-date `trashed_at`.

### 3.4 Unreferenced markdown assets swept on startup (P2)

- **Why e2e:** the asset sweep runs on boot from the history retention pass
  (`retention.ts` → `sweep_unreferenced_markdown_assets`). The SQL and the
  orchestration are unit-tested, but the command wrapper and boot wiring need a
  live app; browser-fallback mode no-ops the command.
- **Steps:** embed an image in a markdown note → delete it from the body and
  save (the asset lingers so editor undo still works) → assert it is still on
  disk → relaunch → assert the sweep purged it; keep an embedded asset
  referenced in a second note → relaunch → assert it survived.
- **Proves:** normal saves keep unreferenced assets reachable, and the boot
  sweep reclaims only those with no live or history reference.
- **Open.**

### 3.5 Sign-in session survives restart (P3)

- **Why e2e:** the session is written to disk and its key to the OS keyring
  (`auth/mod.rs`, excluded from coverage).
- **Steps:** sign in to the test server → relaunch → assert the session is
  restored without a prompt; sign out → relaunch → assert signed out.
- **Proves:** `try_restore`/`has_session`, the keyring and the sync-cursor
  reset on account switch.
- **Open.**

---

## 4. Sharing a folder (two accounts)

Sharing (`sharing/`, `api/sharing.ts`, the notification widget). Every command
is network IO against the sync server, and most flows need **two accounts**, a
sender and a recipient. The pure pieces are unit-tested in `sharing/tests.rs`.
A shared folder is one collection of type `mindstream.shared`: its folders,
notes and attachments are items in it, and its own content is a small
manifest. The `src-tauri/src/sharing` module doc has the model.

Unless noted, the specs are in `multi/sharing.e2e.ts`. The same spec also
checks that a shared drawing loads only trusted embeds, for owner and guest.

### 4.1 Outgoing share creation (P1)

- **Why e2e:** `invite_collection` resolves the recipient's public key
  (`fetch_user_profile`), creates the shared collection with its manifest and
  sends one invitation.
- **Steps:** account A → right-click a folder → **Share folder…** → enter B's
  username and a permission → invite → assert no error and the folder is
  flagged shared-by-me.
- **Proves:** the create-collection → invite chain, and that an unknown
  recipient fails **before** anything is created.
- **Covered.**

### 4.2 An invitation names the folder before it is answered (P1)

- **Why e2e:** the server sends the collection's own item with an invitation,
  and the key inside opens its name. `list_incoming_shares` reads that without
  accepting, and the change feed tells B's device to look, so the notification
  appears without a restart.
- **Steps:** after 4.1, B opens Notifications → assert one entry reading "A
  shared “folder name” with you" → assert the invitation still waits and
  nothing of the folder is on B's device.
- **Proves:** the name preview, the pushed invitation, and that reading is not
  accepting.
- **Covered.**

### 4.3 Accept a share (P1)

- **Why e2e:** `accept_share` accepts the invitation and creates nothing
  locally. The root only appears with the next sync, which pulls the folder and
  (via `project_shared_root`) stamps it shared-with-me.
- **Steps:** B accepts → assert the notification clears → after a sync, assert
  the root appears **in B's Shared view**, not Home.
- **Proves:** the accept, and the projection that marks the root shared.
- **Watch for:** the root in Home with no `shared_role`/`share_id`; a
  read-only recipient whose root stays empty after the first sync.
- **Covered.**

### 4.4 Decline a share (P2)

- **Why e2e:** `decline_share` rejects the invitation on the server, so it must
  not come back.
- **Steps:** send a second share → B declines → assert the notification clears,
  no folder is added, and after a rescan neither the notification nor
  `list_incoming_shares` shows it.
- **Proves:** the reject round trip.
- **Covered.**

### 4.5 (retired)

A share used to be four invitations, one of which could be missing. It is one
invitation now.

### 4.6 An invitation to something that is not a shared folder (P3)

- **Steps:** invite B to a collection of another type, as another program on
  the same server could → assert B gets no notification and
  `list_incoming_shares` leaves it out.
- **Proves:** only a shared folder is offered. Anything else would let its
  maker put a collection of their choosing among B's.
- **Covered.**

### 4.7 Shared subtree content converges (P1)

- **Why e2e:** scoped sync (`sync::scopes`) re-homes a shared folder's subtree
  into the folder's collection and pulls it on the recipient.
- **Steps:** A shares a folder with notes and an embedded image → B accepts →
  after a sync, B sees the notes and the asset → A adds a note and a sub-folder
  with a note, and moves a vault note in → B pulls → all appear. With edit
  rights, B's edit converges back to A.
- **Proves:** rows move from the vault into the shared collection and land on
  the recipient with assets; items created in or moved into the subtree inherit
  its `share_scope_id` without a re-invite.
- **Watch for:** the root arriving under B's tree root by orphan reparenting;
  moving the share root within the vault losing its scope; a read-only
  recipient's local edit looping as a failed push.
- **Covered:** the spec fetches the asset bytes on B through the app API. That
  the image renders in B's editor is open.

### 4.7b A note moved out of a shared folder (P2)

- **Steps:** after 4.7, A moves a note from the shared folder to the vault root
  → syncs → B syncs → assert the note is gone from B's copy of the folder.
- **Proves:** a note moved out is re-homed to the vault and its shared copy
  removed.
- **Covered.**

### 4.8 Offline note edit survives a re-home (P1)

- **Why e2e:** the tombstone path _detaches_ a dirty row instead of deleting
  it, and sync runs pull → scope → push so the detached row is reclaimed by
  stable `id` before the vault push could resurrect it (`apply_remote_delete`
  in `sync/claim.rs`, the phased `run()` in `sync/mod.rs`). Each part is
  unit-tested; the round trip needs two real devices.
- **Steps:** the owner holds folder F on devices A1 and A2. On A1, edit a note
  in F and don't sync. On A2, share F with a second account. Sync A1.
- **Proves:** the unpushed edit is **merged** into the shared copy, F ends up
  shared on A1, and **no orphan vault copy** is left on the server.
- **Watch for:** a duplicate note on any device; the edit surviving on A1 but
  not reaching the second account.
- **Covered:** `multi-a2/sharing-multi-device.e2e.ts`. An unsynced edit stands
  in for being offline; there is no network toggle.

### 4.9 Offline folder rename survives a re-home (P2)

- **Why e2e:** folder metadata is last-write-wins, so `apply_folder_payload`
  keeps local name/parent/position on a dirty row and returns `None` so
  `repair_folder_parents` can't reattach it.
- **Steps:** as 4.8, renaming F (or a subfolder) on A1 instead.
- **Proves:** the rename is kept, stays dirty and is pushed into the shared
  copy.
- **Watch for:** the rename reverting to the pre-share name; a folder moved to
  root in the same window getting reattached under its old parent.
- **Covered:** `multi-a2/sharing-multi-device.e2e.ts`.

### 4.10 Edit-wins-over-delete conflict (P2)

- **Why e2e:** detach-on-dirty makes a locally edited row survive a remote
  tombstone. A deliberate behaviour, only visible with two peers.
- **Steps:** one account on A and B, same vault note N. A edits N offline. B
  deletes N and syncs. A syncs.
- **Proves:** N comes back with A's edit and reappears on B after its next
  pull. An unedited note deleted on B stays deleted on A.
- **Watch for:** signatures are not covered by edit-wins; they still
  hard-delete on a tombstone (`apply_signature`).
- **Covered:** `multi/sync-history.e2e.ts`.

### 4.11 Joining by an invite link (P1)

- **Why e2e:** a link is made, opened and claimed in three requests by two
  accounts, and the folder then arrives by ordinary sync.
- **Steps:** A creates a folder with a note, **Sharing ▸ Share folder… ▸ Invite
  with a link**, picks "Can edit", **Create link**, syncs. B opens **Join
  shared folder…** from the Shared view's background menu, pastes the link,
  **Continue**, **Join**.
- **Proves:** a link shares an unshared folder; it is shown once with its
  secret after the `#`; previewing names sender and folder and joins nothing;
  joining brings the folder under "Shared" with the link's rights; A sees B as
  a member and the one-use link as used and dead.
- **Watch for:** the folder in B's Home; joining after a failed preview; a
  used-up link that still lets someone in.
- **Covered.**

### 4.12 A key that is not the one remembered (P1)

- **Why e2e:** a backend refusal, a notice in two places, and a second request
  carrying the user's choice. Only the app shows that a held-back invitation
  creates nothing and that both people see the same digits.
- **Steps:** A's device is made to remember another key for B (a test-only
  command). A shares a new folder with B. Then B's device remembers another key
  for A, and B opens the invitation.
- **Proves:** with a wrong remembered key, **Invite** shares nothing and shows
  both keys; **Share with the new key** sends it; B sees a warning and only
  **Accept anyway**; the backend refuses a plain accept with `key_changed`.
- **Watch for:** a collection left on the server by the held-back invitation; a
  plain **Accept** next to the warning.
- **Covered.**

### 4.13 An invite link opened outside the app (P2)

- **Why e2e:** Rust unwraps the address and keeps the link, an event tells the
  window, and the window opens the dialog.
- **Steps:** hand the app `mindstream-notes://join?link=…` through the test
  command that stands in for the OS. Then a second one. Then addresses with no
  invite link.
- **Proves:** the dialog opens with the link and looks nothing up; a second
  link replaces the first; other actions, schemes or links open nothing.
- **Not covered here:** the OS part. The suite must not register the scheme on
  its machine.
- **Covered:** `single/invite-link-open.e2e.ts`.

### 4.14 A plan's limit in a shared folder (P1)

- **Why e2e:** a limit set on the server crosses the client library, the sync
  run and an event before the window shows a notice, and whose plan it is
  comes from the folder's local root.
- **Steps:** the server's admin command ends A's plan; A shares a folder with
  B. B adds a note to it and syncs. A adds a vault note and syncs. The limit is
  lifted and both sync again.
- **Proves:** B is told A's plan has ended, with the folder's name, and keeps
  the note; A is told it is their own plan; a second sync shows the same notice
  once; after the lift B's note reaches A.
- **Not covered here:** full storage and an oversized item; the server's and
  the window's unit tests cover those.
- **Covered:** skips itself unless the server runs in a local container
  (`pnpm backend:test:up`).

### 4.15 More access for a member, then less, then none (P1)

- **Steps:** in a folder B may only view, A lets B edit, takes that back, then
  removes B. B syncs after each. A adds a note and syncs.
- **Proves:** each is one step that doesn't fail; B reads the new level, then
  drops its copy; A still owns the share and can write to it.
- **Not covered here:** the server closing B's live sessions; its own tests
  cover that.
- **Covered.**

### 4.16 A removed member's links (P1)

- **Steps:** A makes a link for a folder B is in, removes B in **Manage
  access…**, and answers **Revoke links**.
- **Proves:** removing someone offers to revoke the links still open, naming
  the person removed, and a revoked link no longer opens for B.
- **Covered.**

---

## 5. Spellchecking and text diagnostics

The app checks spelling itself: dictionaries on disk in Rust (`spellcheck/`),
the diagnostics bus and providers (`lib/diagnostics/`), and squiggles and
popovers inside the editors (`editor/plugins/**`). Tokenizing, the syntax
scanners, bus precedence, suggestion ranking and the checker HTTP client are
unit-tested. Dictionaries loaded by `spellbook`, the `spellcheck_*` commands,
the personal dictionary in SQLite and decorations over a live document need the
app.

### 5.1 Install a dictionary → a misspelling is flagged (P1)

- **Why e2e:** the install validates by _loading_ the `.aff`/`.dic` pair, so
  "the download worked" and "the dictionary works" are one assertion only here.
- **Steps:** launch with an empty dictionary directory → **Settings → Language
  → Spelling** → **Browse more languages** → install `de_DE_frami` → select it
  → type `Gescwindigkeit ist wichtig` → assert one squiggle.
- **Proves:** catalogue → download → stage → load → check, and that an
  unselected language contributes nothing. A truncated or HTML-error download
  must leave nothing installed.
- **Covered, in part:** `single/spellcheck.e2e.ts` seeds a fixture pair into
  the run's dictionary directory. The download needs a stub catalogue host.

### 5.2 Correct a word from the popover (P1)

- **Steps:** type a misspelling → click the squiggle → assert corrections,
  best first → apply one → assert the text changed, the squiggle is gone, and
  undo restores the misspelling in one step.
- **Proves:** `spellcheck_suggest` runs only when the popover opens, and a
  replacement is one undoable edit.
- **Covered, in part:** `single/spellcheck.e2e.ts`; the single undo step is
  not asserted.

### 5.3 Personal dictionary survives a restart (P1)

- **Steps:** **Add to dictionary** from the popover → assert the squiggle goes
  in every open note → restart → assert the word is still accepted and listed
  in settings → remove it there → assert the squiggle returns without a
  restart.
- **Proves:** the invalidation reaches every editor, and the word round-trips
  through SQLite in the casing typed while matching other casings.
- **Covered:** `single/spellcheck.e2e.ts`.

### 5.4 A plugin checker takes spelling over (P2)

- **Why e2e:** a plugin's `textChecker`, the endpoint setting and the bus's
  kind ownership only meet at runtime.
- **Steps:** enable LanguageTool with a stub service on loopback → point the
  endpoint at it → **Test connection** → assert its languages are listed and a
  missing selected language is named → type text the stub flags → assert
  grammar and spelling findings, and that the dictionary doesn't report the
  same word twice → turn the plugin's spelling off → assert the dictionary
  takes spelling back.
- **Proves:** ownership end to end, and that a checker with no endpoint adds no
  squiggles instead of silencing the dictionary.
- **Note:** the stub must assert it received the fixed probe on **Test
  connection** and note text only on a real check.
- **Covered, in part:** `single/text-checker.e2e.ts` covers the probe without a
  body, findings, the selected language sent with each check, replacement and
  switching off. The spelling handover is open.

### 5.5 Removing a dictionary takes effect immediately (P2)

- **Why e2e:** `spellcheck_remove_dictionary` deletes the files and drops the
  cached copy; without the second half checks continue until a restart.
- **Steps:** remove an installed dictionary → assert words are flagged
  differently without a restart → restart → assert the files are gone and the
  catalogue offers it again.
- **Covered, in part:** `single/spellcheck.e2e.ts` asserts the panel offers
  the download at once and the files are gone after a restart. The change in
  flagged words is not asserted.

### 5.6 Syntax-aware checking in a source editor (P2)

- **Why e2e:** source mode decorates CodeMirror and WYSIWYG decorates
  ProseMirror; this proves offsets survive both position models.
- **Steps:** open a Typst note in Split view → mix a `#set` rule, a comment, a
  raw block and prose with one misspelling → assert one squiggle in both panes
  → edit the paragraph above → assert the squiggle tracks its word.
- **Proves:** rebased offsets land on the right characters, and masked syntax
  never reaches the dictionary.
- **Covered, in part:** `single/spellcheck.e2e.ts` on the markdown source
  surface. Typst and Split view are open.

---

## 6. Account sessions and security

`auth/mod.rs` needs a server, and the server's own suite drives every account
route through the client library (`backend/server/tests/client_account.rs`).
What is left is the app end to end. A rejected session signs the device out;
the app does not sign itself back in.

### 6.1 A new device is asked for a code (P1)

- **Steps:** A creates an account and turns two-factor sign-in on. B signs in
  through the form: the password brings up the code field, a backup code lets
  it in.
- **Covered:** `multi/account-security.e2e.ts`.

### 6.2 An ended session signs the device out (P1)

- **Steps:** A ends B's session from the device list, then changes the
  password. Each time B is signed out unasked, keeps its notes and shows
  "Signed out on this device"; A then lists one device.
- **Covered:** `multi/account-security.e2e.ts`.

### 6.3 Recovery through the form (P2)

- **Why e2e:** recovery ends by showing a new recovery key before the window
  reloads. The server suite covers the requests, nothing covers the form
  holding the reload until the key is acknowledged.
- **Steps:** sign up → note the recovery key → sign out → "Forgot your
  password?" → type the key in lower case with spaces, and a new password →
  assert the new key is shown and the window has not reloaded → acknowledge →
  assert signed in and the old password refused.
- **Open.**

### 6.4 Same-server sign-out/sign-in does not duplicate the vault (P1)

- **Why e2e:** `reset_sync_cursors` clears every `etebase_uid` on sign-out. The
  vault re-converges only if `ensure_collection` adopts instead of creating,
  `run` pulls before pushing, `apply_note_payload` re-links by payload id, and
  `push_notes` takes its update branch. Only the third has a unit test
  (`apply_note_relinks_a_row_whose_etebase_uid_was_cleared`).
- **Steps:** sign in → create N notes and sync → sign out → sign into the
  **same** account → sync → assert the server holds N items, not 2N, and no
  duplicate titles appear.
- **Open.**

---

## 7. Android

There is no Android tier (see [strategy.md](strategy.md#android-is-not-a-tier-yet)).
Bugs found by hand on a tablet, such as text selection, the slash menu in a
scrolling pane and spellcheck settings on mobile, are WebView behaviour no
current tier can catch. None of the plan below is prototyped.

**Approach.** Appium with the UiAutomator2 driver, switching into the
`WEBVIEW_com.jannikgohr.mindstream_notes` context so chromedriver drives the
System WebView. The WebdriverIO runner and the ARIA selectors carry over;
`tauri-driver` does not. Chromedriver/WebView version skew is the classic
failure mode, because the device's WebView updates itself.

**Harness work, in order:**

- [ ] Confirm Tauri Android debug builds enable WebView debugging
      (`setWebContentsDebuggingEnabled`). Everything depends on it.
- [ ] Per-spec isolation. Android apps don't inherit the environment, so the
      data-dir override doesn't reach them. Start with
      `adb shell pm clear com.jannikgohr.mindstream_notes` (slow, wipes the
      keyring too); later read the override from an intent extra, gated like
      the env var.
- [ ] An Appium config reusing the wdio runner.
- [ ] Backend reachability for sync flows: an emulator reaches the host at
      `10.0.2.2`, a physical device needs a routable address.

**Stages**, each useful on its own:

| Stage  | Scope                                                                         | Needs                     |
| ------ | ----------------------------------------------------------------------------- | ------------------------- |
| **A1** | Smoke: launch, attach the webview, tree renders, open a note, type, reopen    | Appium, WebView debugging |
| **A2** | Mobile journeys: text selection, IME, slash menu, mobile settings, spellcheck | A1 + isolation            |
| **A3** | Restart, the Android keyring round-trip, backgrounding and process death      | A2                        |
| **A4** | Sync against the test backend, including §6 on the device                     | A3 + reachable backend    |

Flows worth writing first: a smoke test (A1); long-press selection and the
slash menu staying anchored in a scrolled pane (A2); installing `en_US`, then
long-pressing a misspelling and checking the popover opens below the word
(A2); a session restored after force-stop (A3); an ended session clearing the
Android keyring entry (A4).

Android should not prove what is platform-independent. Sync, sharing, history
and CRDT semantics belong in T4 on desktop. Anything decidable without touch
belongs in a unit test: the "every word is unknown with no dictionary" bug
surfaced on Android but is covered by Rust tests on `unknown_words`.

---

## Specs outside the numbered flows

| Spec                             | Proves                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `single/history.e2e.ts`          | capture, restore, Undo, editor-undo isolation and history across a restart, for markdown                  |
| `single/close-save.e2e.ts`       | the last edit is saved when the main window closes at once, and a popout saves before returning its note  |
| `single/drawing-embeds.e2e.ts`   | https embeds in a drawing load under the packaged app's CSP                                               |
| `single/journal.e2e.ts`          | the Journal calendar creates today's note from a template, once per day, and falls back when disabled     |
| `single/plugins.e2e.ts`          | discovery, a bundled Rust component over IPC, the settings overview, disabled state across a restart      |
| `single/plugin-lifecycle.e2e.ts` | a signed Wasm plugin's approval, storage, disable and remove, without blocking frames or another plugin   |
| `single/import-notes.e2e.ts`     | an Obsidian vault import with links, assets and counts, across a restart                                  |
| `multi/collab-confirm.e2e.ts`    | restore asks for confirmation with a peer present (markdown/PDF), not when solo, and not for ink/freeform |
| `multi/seed-merge.e2e.ts`        | demo notes seeded on two devices of one account converge without duplicated bodies                        |
| `multi/sync-history.e2e.ts`      | history stays per device: B converges on A's restore without a "reverted" entry of its own                |

History for drawing, handwriting and PDF notes is not covered in the packaged
app; the harness can't yet seed those note kinds. Ink and freeform report no
presence, so they never ask before a restore (see
[limitations.md](../limitations.md)).
