# End-to-end test flows

The unit suites (`vitest` for the frontend, `cargo test` for the backend)
cover the **logic layer** and gate it at 80% line coverage. Everything they
_exclude_ — see the exclude lists in `vitest.config.ts` and
`src-tauri/scripts/rust-coverage.mjs` — is integration surface that only has
meaning when the whole stack runs together: the Tauri IPC boundary, the
Etebase network sync, the native dialogs and file system, the editor/canvas
frameworks, and cross-restart persistence.

Those surfaces are the e2e backlog. This document **defines** the flows worth
covering (it does not implement them). They are grouped by the three
categories that justify an end-to-end test rather than a unit test.

> **See also:** [e2e-strategy.md](e2e-strategy.md) for _how_ to run these
> against a real Tauri backend and the mindstream-server stack (the test tiers,
> the backend harness, the collaboration matrix), and
> [known-limitations.md](known-limitations.md) for the by-design behaviours
> several of these flows are meant to pin down.

The existing `e2e/` Playwright suite runs the SvelteKit SPA in
**browser-fallback mode** (the in-memory mock store backs every API call), so
it already covers the pure-UI journeys (app shell, search dialog, note/folder
creation, source switching). The flows below need something the fallback
can't give: a real Rust backend, a real disk, a real network peer, or a real
app restart. Implementing them means driving the **packaged Tauri app** (e.g.
WebDriver via `tauri-driver` + a headless display, or a Tauri test harness),
not just `vite preview`.

Priority: **P1** = core, ship-blocking; **P2** = important; **P3** = nice to
have.

---

## 1. Critical user journeys

The absolute core workflows. If one of these breaks, the app is broken.

### 1.1 Create → edit → reopen a markdown note (P1)

- **Why e2e:** exercises the Milkdown/ProseMirror editor + y-prosemirror CRDT
  - the `save_note` IPC + SQLite persistence — all excluded from unit
    coverage (`editor/**`, `api/notes.ts`, `notes/mod.rs` command layer).
- **Steps:** launch app → create note → type rich content (heading, bold,
  list, code block) → switch to another note and back → assert the rendered
  content survives.
- **Proves:** the editor↔CRDT↔DB round-trip and that body/markdown
  serialisation is lossless.

### 1.2 Export the vault to disk (P1)

- **Why e2e:** `backup_now` pops a native save dialog, `VACUUM INTO`s the live
  DB, zips it, and writes atomically — the `run_backup` orchestration needs a
  real `AppHandle` + filesystem and is intentionally excluded from unit
  coverage.
- **Steps:** seed a few notes/folders → trigger **Settings → Data → Export
  vault** → choose a destination → assert a `.zip` is written and the result
  dialog reports the correct counts.
- **Proves:** the whole export chain end to end, including the
  manifest/counts the dialog builders (unit-tested in
  `export-result-dialog.svelte.test.ts`) render.

### 1.3 Import / restore a backup (P1)

- **Why e2e:** import opens a file picker, extracts into a staging dir, runs
  migrations on the staged DB, and (for restore) stages a pending DB + relaunches.
  The restart half can only be verified by actually restarting.
- **Steps:** export a vault (1.2) → wipe/alter the live vault → **Import** the
  zip → choose _Restore_ → let the app relaunch → assert the imported
  notes/folders are present and the live DB was swapped.
- **Proves:** `import_begin` → `import_restore` → `apply_pending_restore_if_any`
  across a real restart (the file-swap helpers are unit-tested, the
  orchestration is not).

### 1.4 Import / merge a backup (P2)

- **Steps:** import a zip → choose _Merge_ → assert only rows whose ids don't
  already exist are added, orphaned parents are rerouted to root, and the
  merge-result dialog counts match.
- **Proves:** the in-process `merge_into` path wired through the real IPC +
  dialog (the SQL merge logic itself is unit-tested in `backup.rs`).

### 1.5 Trash → restore → purge a note (P1)

- **Why e2e:** spans the tree store, the `trash_note`/`restore`/`purge` IPC,
  and the `trashed_at` column semantics across the Trash view.
- **Steps:** trash a note → confirm it leaves Home and appears under Trash →
  restore it → confirm it returns → trash again → empty trash → confirm it's
  gone.
- **Proves:** the soft-delete lifecycle and that `trashed_at` is set/cleared
  on every path (see the `feedback_trashed_at_populated` invariant).

### 1.6 Ink / drawing note round-trip (P2)

- **Why e2e:** the ink canvas (`ink/editor-helpers.ts`) and Excalidraw island
  (`freeform/**`) are pointer/canvas/React surfaces excluded from unit
  coverage; only the pure geometry/document model is unit-tested.
- **Steps:** create a drawing note → draw a few strokes → reopen → assert the
  strokes persist and render.
- **Proves:** stroke capture → Y.Doc encode → asset persistence → decode.

---

## 2. IPC-heavy operations

A UI action that delegates to Rust to touch the OS, then renders the result
back. The value is proving the whole frontend↔Rust↔frontend chain.

### 2.1 Tree hydration from the database (P1)

- **Why e2e:** `loadTree` calls `list_notes` + `list_collections` over IPC and
  assembles the tree. Unit tests use the mock store; this proves the real
  Rust query + serialisation matches what the UI expects.
- **Steps:** launch with a seeded DB → assert the file explorer renders the
  expected folder/note hierarchy with correct kinds/icons.
- **Proves:** the Rust `notes`/`collections` read path and the
  `NoteSummary`/`TreeNode` wire contract.

### 2.2 PDF import → render → annotate → export (P2)

- **Why e2e:** `import_pdf_note` stores the binary as an app-owned asset,
  pdf.js renders it, and `pdf_export` (excluded — printpdf/IO) bakes
  annotations back in.
- **Steps:** import a PDF → assert pages render → add a highlight + a
  signature → export the annotated PDF → assert the output file exists and
  re-opens.
- **Proves:** asset IPC + pdf.js render + the annotation→PDF pipeline.

### 2.3 Signature photo import → place → export (P2)

- **Why e2e:** photo signature import crosses surfaces unit tests cannot
  faithfully exercise: OS camera/file capture, `createImageBitmap`, real
  canvas rasterisation, live preview frame capture, pointer-driven manual crop
  handles, pdf.js placement, and the final annotated-PDF export.
- **Steps:** import a PDF → open the signature picker → choose **Import from
  photo** → exercise both a picked image and, where available, camera capture →
  confirm paper auto-crop can be toggled → adjust the manual crop handles →
  save the signature → place it on the PDF → export the annotated PDF → reopen
  the output and assert the transparent signature image appears at the chosen
  placement.
- **Proves:** the DOM acquisition layer in `signature-import-image.ts`, the
  `SignatureImportDialog.svelte` source/crop/adjust states, scanned-signature
  image persistence in saved signatures, placement in `PdfNoteViewer.svelte`,
  and the image appearance path in `exportAnnotatedPdf`.

### 2.4 Full-text search against the Rust matcher (P2)

- **Why e2e:** the production search runs in Rust (`search/mod.rs`); the TS
  `search-matcher.ts` is only the browser-fallback mirror (unit-tested).
- **Steps:** seed notes → open search → type a query → assert the Rust-ranked
  results + highlight ranges match expectations.
- **Proves:** the two matchers stay behaviourally aligned (AND semantics,
  scoring, snippet windows).

### 2.5 Open vault folder / reveal in OS file manager (P3)

- **Steps:** **Settings → Data → Open data folder** → assert the shell opens
  the correct path (mock/intercept the shell call).
- **Proves:** the `open_data_folder`/`open_with_shell` command shims.

### 2.6 Live collaboration between two windows (P3)

- **Why e2e:** the collab providers (`sync/collab-provider.ts`,
  `ink-web-collab-provider.ts`) and the Etebase room plumbing are network
  surfaces excluded from unit coverage.
- **Steps:** open the same note in two windows/clients → type in one → assert
  the edit appears in the other; toggle offline → assert reconnect converges.
- **Proves:** the y-protocols transport + awareness + reconnection.

### 2.7 macOS native menu and window chrome (P2)

- **Why e2e:** the native menu (`native_menu.rs`) and frontend listener bridge
  (`native-menu.svelte.ts`) only have meaning when Tauri owns the real macOS
  menu bar, focused windows, accelerators, Dock activation, and native window
  decorations. Unit tests cover the pure command-id/default mapping; this flow
  proves the platform integration excluded from coverage.
- **Steps:** launch the packaged macOS app -> confirm native decorations are the
  default -> toggle custom window decorations and relaunch if required -> use
  File menu commands to create each note kind and import a PDF -> use Edit menu
  undo/redo/cut/copy/paste/select-all in markdown, ink/PDF where supported, and
  normal inputs -> use View menu sidebar/metadata/search/theme commands -> open
  note popout windows and switch between them from the Window menu -> close the
  main window and reopen it from the Dock.
- **Proves:** Rust menu item ids route to the focused webview, frontend commands
  enter the existing hotkey bus once, native/default window chrome state matches
  settings, and macOS close/Dock/window switching behaviour feels native.

---

## 3. State persistence across restart

Change something the app saves to disk, restart, and verify it stuck. These
are the only flows that can prove the persistence boundary because the proof
_is_ the restart.

### 3.1 Settings persist across restart (P1)

- **Why e2e:** binding-backed settings (theme, language, autostart, tray) are
  written through `desktop_settings` IPC to disk / OS; the bindings are
  unit-tested off-Tauri (no-op branches) but the real persistence is not.
- **Steps:** change theme to Dark + language to German + toggle "close to
  tray" → quit → relaunch → assert all three are remembered.
- **Proves:** `set_desktop_setting`/`get_desktop_setting` round-trip and the
  startup hydration in `settings/store.svelte.ts`.

### 3.2 Sidebar / sort UI preferences persist (P2)

- **Steps:** collapse a sidebar, resize it, change the sort strategy/direction
  → relaunch → assert the layout is restored.
- **Proves:** `preferences.ts` debounced save → `localStorage`/disk → rehydrate
  into `ui` state (`state.svelte.ts`).

### 3.3 Trash retention sweep on startup (P2)

- **Why e2e:** `spawn_retention_sweep` runs on boot and purges trashed items
  older than the retention window — a scheduled, time-based backend job.
- **Steps:** trash an item and back-date its `trashed_at` past the retention
  window → relaunch → assert it was purged; trash a fresh item → relaunch →
  assert it survived.
- **Proves:** the retention scheduler + `sweep` cascade (the SQL `sweep` is
  unit-tested; the boot wiring is not).

### 3.4 Unreferenced markdown assets swept on startup (P2)

- **Why e2e:** the markdown asset sweep runs on boot from the history
  retention pass (`retention.ts` → `sweep_unreferenced_markdown_assets` IPC →
  `sweepUnreferencedMarkdownAssetsInner`). The SQL sweep and the frontend
  orchestration are unit-tested (`assets/mod.rs`, `retention.test.ts`), but the
  `#[tauri::command]` wrapper + real `State<Db>` + boot wiring need a live app —
  the command is `invokeOrFallback`, so browser-fallback mode no-ops it.
- **Steps:** in a markdown note, insert an embedded image asset → delete it from
  the body and save (the asset lingers so editor undo still works) → assert the
  asset is still on disk → relaunch → assert the startup sweep purged it; in a
  second note keep an embedded asset referenced → relaunch → assert it survived.
- **Proves:** the deferred-cleanup contract — normal saves keep unreferenced
  assets reachable, and the boot sweep reclaims only the ones with no live or
  history reference (see `startup_sweep_*` unit tests for the SQL half).

### 3.5 Sign-in session survives restart (P3)

- **Why e2e:** the Etebase session blob is written to disk and its key to the
  OS keyring (`auth/mod.rs`, excluded — network + keyring).
- **Steps:** sign in to a (test) Etebase server → relaunch → assert the app
  restores the session without re-prompting; sign out → relaunch → assert
  signed-out.
- **Proves:** `try_restore`/`has_session` + keyring + sync-cursor reset on
  account switch.

---

## 4. Collection sharing (multi-account)

Manifest-backed collection sharing (`sharing.rs`, `api/sharing.ts`, the
notification widgets). Every command here is Etebase network IO — excluded from
unit coverage — and the meaningful flows need **two distinct accounts** (a
sender and a recipient), which is a stronger requirement than the §2.6 collab
matrix's "same account, two devices". The pure pieces (manifest bundling,
sender/access fallback, `build_share_manifest`, migration 18) are unit-tested in
`sharing.rs`; everything below is the wire round-trip those tests can't reach.

> A shared folder scope is one `mindstream.share_manifest` collection (its
> content is the manifest JSON) plus three required part collections —
> `mindstream.folders`, `mindstream.notes`, `mindstream.assets`. See the
> `src-tauri/src/sharing.rs` module doc for the model.

### 4.1 Outgoing share creation (P1)

- **Why e2e:** `invite_collection` creates the four scope collections, writes
  the manifest as the manifest collection's content, resolves the recipient's
  public key (`fetch_user_profile`), and sends four `invite`s — all live
  Etebase calls with no unit coverage.
- **Steps:** account A → right-click a folder → **Share folder…** → enter B's
  username + a permission → invite → assert the call succeeds, the dialog shows
  no error, and the local folder is now flagged shared-by-me in the tree.
- **Proves:** the create-collections → write-manifest → invite chain, and that
  an unknown recipient username fails **before** any collections are created
  (pubkey lookup is first).

### 4.2 Incoming share shows as one bundle, not N invites (P1)

- **Why e2e:** `list_incoming_share_bundles` transparently accepts the pending
  manifest invite, fetches + decodes the manifest, and groups the part invites;
  the scan then upserts a single `share-bundle` notification. Proving "one
  notification, not four" is the whole point of the manifest model.
- **Steps:** after 4.1, account B opens Notifications → assert exactly one
  `share-bundle` entry showing A's username + the folder name (not separate
  manifest/folders/notes/assets invites).
- **Proves:** manifest auto-accept + decode + bundling end to end, and that the
  referenced part invites are hidden from the raw invite list.

### 4.3 Accept a share bundle (P1)

- **Why e2e:** `accept_share_bundle` accepts every referenced part invite and
  projects a local shared root anchored on the folders collection.
- **Steps:** account B accepts the 4.2 bundle → assert the notification clears,
  the shared root folder appears in B's tree named after the manifest, and a
  rescan does not resurrect the bundle.
- **Proves:** bundled accept + `record_accepted_share` local projection + the
  scan reconciliation that drops accepted bundles.

### 4.4 Decline a share bundle (P2)

- **Why e2e:** `decline_share_bundle` rejects the pending part invites **and**
  leaves the auto-accepted manifest collection, so the transparent accept is
  fully undone and the bundle must not reappear on the next scan.
- **Steps:** send a second share to B → B declines → assert the notification
  clears, no shared folder is added, and a rescan (which re-lists manifest
  collections) does **not** bring the bundle back.
- **Proves:** the leave-manifest cleanup — the regression guard that a declined
  share doesn't loop back because its manifest collection was still a member.

### 4.5 Incomplete bundle can't be accepted (P2)

- **Why e2e:** a bundle missing a required part (esp. `assets`) is marked
  `complete: false`; the widget disables **Accept** and shows the incomplete
  warning. Needs a manifest whose part invite is missing/revoked.
- **Steps:** construct a share missing one required part invite (e.g. cancel the
  assets invite server-side after creation) → assert B's `share-bundle`
  notification shows the incomplete message and Accept is disabled while Decline
  stays available.
- **Proves:** the `complete`/`warnings` plumbing from `bundle_incoming_share_invitations`
  through to the widget's disabled-accept guard.

### 4.6 Non-manifest invitation still surfaces (P3)

- **Steps:** invite B directly to a lone collection whose type isn't part of a
  manifest scope → assert it shows as a single `collaboration-invite`
  notification (the legacy widget), independent of the bundle path.
- **Proves:** `unbundled_invitations` still reach the UI so non-manifest shares
  aren't silently dropped.

### 4.7 Shared subtree content converges (P1)

- **Why e2e:** scoped sync routing (`sync::scopes`) re-homes a shared folder's
  subtree into the scope's collections and pulls it on the recipient — a live
  two-account, real-Etebase round-trip with no unit coverage beyond the
  `migrate_subtree_into_scope` detach logic.
- **Steps:** A shares a folder containing notes + an embedded image → B accepts
  → after a sync, assert B sees the folder's notes and the asset renders → A
  adds a note in the shared folder, re-invites (or, once scope inheritance
  lands, just adds it) → B pulls → assert it appears. If B has read-write, an
  edit in B converges back to A.
- **Proves:** scope-tagged rows migrate out of the vault into the scope
  collections (owner side) and land on the recipient with assets resolving (no
  "partial media unavailable" state).
- **Watch for:** the shared root arriving under B's tree root via orphan-reparent
  (the sender's parent id doesn't exist on B); a note added to the shared folder
  _after_ the share not appearing until a re-invite (scope inheritance on
  create/move is a known follow-up); a read-only recipient's local edit looping
  as a failed scope push.

### 4.8 Offline note edit survives a re-home (P1)

- **Why e2e:** the non-destructive re-home is the reason the tombstone path
  _detaches_ a dirty row instead of deleting it, and the sync runs in
  pull → scope → push phases so the detached row is reclaimed by stable `id`
  before the vault push could resurrect it (`apply_remote_delete` + the phased
  `run()` in `sync/mod.rs`). The `apply_note_payload` merge and the detach are
  unit-tested in isolation, but the full "vault tombstone then scope pull in one
  networked sync, no orphan left behind" round-trip needs two real devices.
- **Steps:** the owner signs in on device A and device B, both holding folder F.
  Take A **offline** and edit a note in F (leave it unpushed, `dirty=1`). On B,
  **Share folder…** F with a second account (this re-homes F into a scope). Bring
  A back **online** and let it sync.
- **Proves:** A's offline edit is **merged** into the scope copy (CRDT body
  merge), not silently dropped; F ends up in the scope on A; and **no orphan
  vault copy** of the note is left on the server (which would flip-flop the note
  between vault and scope on every device).
- **Watch for:** a duplicate note appearing on any device (orphan resurrection —
  the exact failure the phase ordering prevents); the edit surviving on A but
  lost on the second account (merge didn't reach the scope push); the note
  briefly showing with no server identity (`etebase_uid = NULL`) if A is killed
  mid-sync between the detach and the push — harmless, the next sync re-homes it.

### 4.9 Offline folder rename survives a re-home (P2)

- **Why e2e:** folder metadata is last-write-wins, not a CRDT, so
  `apply_folder_payload` preserves local name/parent/position when the row is
  dirty (mirroring the note path) and returns `None` so `repair_folder_parents`
  can't reattach it from the remote payload. Unit-tested for the single-row
  decision; the cross-device ordering is not.
- **Steps:** owner on A + B, both holding folder F. A **offline**, rename F (or a
  subfolder of F). B **shares** F. A back **online**, sync.
- **Proves:** A's offline rename is kept (the folder is re-homed into the scope
  without reverting to the remote name), stays dirty, and pushes the rename into
  the scope.
- **Watch for:** the rename reverting to the pre-share name (LWW clobber — the
  regression this guards); a folder **moved to root offline** during the same
  window getting reattached under its old parent by the repair pass (the
  `keep_local_meta → return None` guard is meant to prevent this — worth an
  explicit case).

### 4.10 Edit-wins-over-delete conflict (P2)

- **Why e2e:** the detach-on-dirty rule also changes the genuine
  delete-vs-offline-edit conflict from "delete wins" to "edit wins": a locally
  edited row resurrects rather than being destroyed by a remote tombstone. This
  is a deliberate cross-device behaviour, only observable with two peers.
- **Steps:** owner on A + B, same note N (not shared — plain vault). A
  **offline**, edit N (unpushed). On B, **delete** N and let it sync. Bring A
  **online**.
- **Proves:** N is **resurrected** with A's edit and reappears on B after B's
  next pull (edit wins, no silent loss). A clean (unedited) note deleted on B
  stays deleted on A (the control case).
- **Watch for:** the resurrection failing to propagate back to B (A re-created it
  with a new uid; B must pull it as a new note); **signatures** are intentionally
  _not_ covered by edit-wins — they still hard-delete on a tombstone
  (`apply_signature`), so don't expect a deleted-but-edited signature to
  resurrect.

---

## Implementation notes

- **Harness:** these need the real app, so drive the packaged Tauri binary
  with `tauri-driver` (WebDriver) under a headless display (e.g. `xvfb` on
  Linux CI), or Tauri's mock runtime where a full binary is overkill.
- **Native dialogs:** file/folder pickers (export, import, open-folder) must
  be stubbed or pre-seeded — WebDriver can't click an OS dialog. Prefer a test
  hook that injects the path over driving the native widget.
- **Network flows (§2.6, §3.5, §4):** stand up a disposable Etebase server (the
  `backend/` compose stack) or a mock, and tag these tests so they can be
  skipped when no server is available.
- **Two-account flows (§4 sharing):** unlike the §2.6 collab matrix (one account
  on two devices), the sharing flows need **two distinct Etebase users** — a
  sender and a recipient — plus a way to script an invite between them. See
  [e2e-strategy.md](e2e-strategy.md) §2.1 for the account-provisioning
  requirement this adds.
- **Restart flows (§3):** the test harness must be able to quit and relaunch
  the same data directory. Set the `MINDSTREAM_PROFILE_DIR` env var to a temp
  directory per test so runs are isolated and a restart picks up the same
  on-disk state; optionally set `MINDSTREAM_PROFILE_ID` to namespace that
  run's keyring entry. This override is the active-profile seam in
  `src-tauri/src/profiles.rs` (`dir_override`); it bypasses the profiles
  index entirely. It is gated to dev builds (`debug_assertions`) and to
  release builds compiled with `--features e2e-data-dir`, so a shipped
  production binary can never be redirected by a stray env var.
