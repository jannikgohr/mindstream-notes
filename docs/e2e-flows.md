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

### 2.3 Full-text search against the Rust matcher (P2)

- **Why e2e:** the production search runs in Rust (`search/mod.rs`); the TS
  `search-matcher.ts` is only the browser-fallback mirror (unit-tested).
- **Steps:** seed notes → open search → type a query → assert the Rust-ranked
  results + highlight ranges match expectations.
- **Proves:** the two matchers stay behaviourally aligned (AND semantics,
  scoring, snippet windows).

### 2.4 Open vault folder / reveal in OS file manager (P3)

- **Steps:** **Settings → Data → Open data folder** → assert the shell opens
  the correct path (mock/intercept the shell call).
- **Proves:** the `open_data_folder`/`open_with_shell` command shims.

### 2.5 Live collaboration between two windows (P3)

- **Why e2e:** the collab providers (`sync/collab-provider.ts`,
  `ink-web-collab-provider.ts`) and the Etebase room plumbing are network
  surfaces excluded from unit coverage.
- **Steps:** open the same note in two windows/clients → type in one → assert
  the edit appears in the other; toggle offline → assert reconnect converges.
- **Proves:** the y-protocols transport + awareness + reconnection.

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

### 3.4 Sign-in session survives restart (P3)

- **Why e2e:** the Etebase session blob is written to disk and its key to the
  OS keyring (`auth/mod.rs`, excluded — network + keyring).
- **Steps:** sign in to a (test) Etebase server → relaunch → assert the app
  restores the session without re-prompting; sign out → relaunch → assert
  signed-out.
- **Proves:** `try_restore`/`has_session` + keyring + sync-cursor reset on
  account switch.

---

## Implementation notes

- **Harness:** these need the real app, so drive the packaged Tauri binary
  with `tauri-driver` (WebDriver) under a headless display (e.g. `xvfb` on
  Linux CI), or Tauri's mock runtime where a full binary is overkill.
- **Native dialogs:** file/folder pickers (export, import, open-folder) must
  be stubbed or pre-seeded — WebDriver can't click an OS dialog. Prefer a test
  hook that injects the path over driving the native widget.
- **Network flows (2.5, 3.4):** stand up a disposable Etebase server (the
  `backend/` compose stack) or a mock, and tag these tests so they can be
  skipped when no server is available.
- **Restart flows (§3):** the test harness must be able to quit and relaunch
  the same data directory. Set the `MINDSTREAM_PROFILE_DIR` env var to a temp
  directory per test so runs are isolated and a restart picks up the same
  on-disk state; optionally set `MINDSTREAM_PROFILE_ID` to namespace that
  run's keyring entry. This override is the active-profile seam in
  `src-tauri/src/profiles.rs` (`dir_override`); it bypasses the profiles
  index entirely. It is gated to dev builds (`debug_assertions`) and to
  release builds compiled with `--features e2e-data-dir`, so a shipped
  production binary can never be redirected by a stray env var.
