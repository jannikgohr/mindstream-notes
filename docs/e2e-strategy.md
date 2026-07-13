# End-to-end testing strategy: real backend & live collaboration

[e2e-flows.md](e2e-flows.md) is the **catalogue** of flows worth covering. This
document is the **strategy** for the slice those flows can't reach with the
current browser-fallback harness: features that only have meaning against a real
Tauri backend (real Rust + SQLite + disk) and, for sync and collaboration, a
real **mindstream-server** backend stack.

It exists because the note-history work added a class of behaviour —
version restore, the cross-device timeline, live-collab restore propagation, the
planned collab-confirmation guard — whose correctness _is_ the multi-process,
multi-device interaction. A mock store cannot prove any of it.

The known trade-offs these tests are meant to pin down (so we notice if they
regress) are in [known-limitations.md](known-limitations.md).

---

## 1. The four test tiers

| Tier                          | Runs                                           | Backs the API with                         | Proves                                                                            |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| **T1 Unit**                   | `pnpm test`, `cargo test`                      | n/a (pure logic)                           | dedup, deltas, compression, doc model, restore math                               |
| **T2 Browser-fallback**       | `pnpm test:e2e` (Playwright, port 1440)        | in-memory mock store                       | pure-UI journeys: history list, restore button states, Undo banner, action labels |
| **T3 Single-client Tauri**    | `tauri-driver` on the packaged app             | real Rust + SQLite + disk                  | the real capture/restore/undo round-trip + persistence across restart             |
| **T4 Multi-client + backend** | two `tauri-driver` apps + the `backend/` stack | real Etebase + yjs-relay + excalidraw-room | sync convergence and live-collab restore semantics                                |

T1/T2 exist today. **T3 and T4 are the new work.** Everything below is about
standing them up.

A feature should be tested at the **lowest tier that can actually prove it**:
the Undo _banner rendering_ is T2 (mock store already implements
`captureCurrentNoteVersion` et al.); the Undo _round-trip through SQLite_ is T3;
"undo on device A converges on device B" is T4.

---

## 2. The mindstream-server test backend

"mindstream-server" is the `backend/` Docker Compose stack: one nginx front door
path-routing to **Etebase** (encrypted storage + auth, on Postgres),
**yjs-relay** (markdown + PDF Yjs collab), and **excalidraw-room** (freeform live
sync). The client talks to a single URL and derives the collab WebSocket paths
itself. See [backend/README.md](../backend/README.md).

### Bring it up for tests

```sh
cd backend
cp .env.example .env            # set POSTGRES_PASSWORD
docker compose up -d --build    # stack at http://localhost:8080
```

The client connects via **Settings → Account → Self-hosted → Server URL =
`http://localhost:8080`**. For e2e this should be injected, not typed — see §3.

### Requirements to make it test-grade

These are the gaps to close before T4 is runnable; track them as the backend
test harness lands:

1. **Programmatic throwaway accounts.** Each run needs a fresh Etebase user (or
   a fresh collection under a shared user) so runs don't cross-contaminate.
   Either script account creation against the Etebase admin/signup API, or
   pre-seed one fixture account and namespace per-run data by collection. The
   superuser password is printed once on first boot
   (`docker compose logs etebase | grep -i password`). **Collection sharing
   (§5, [e2e-flows.md](e2e-flows.md) §4) needs two _distinct_ users** — a sender
   and a recipient whose public key the sender resolves via
   `fetch_user_profile` — so the shared-collection namespacing trick isn't
   enough there; those runs must provision two real accounts.
2. **Health gating.** Block tests until the stack is ready: nginx `/healthz`,
   a TCP connect to yjs-relay `:1234`, the excalidraw-room socket.io handshake,
   and Etebase accepting connections (the compose healthchecks already encode
   each probe — reuse them). **Landed:** `e2e-tests/backend/backend-health.spec.ts`
   probes all four through the single nginx edge (run with
   `MINDSTREAM_E2E_BACKEND=1 pnpm test:e2e:backend`; see §6/§7).
3. **Isolation & teardown.** A disposable Postgres volume per run (or per-run
   collections plus cleanup) so state never leaks between runs.
4. **Capability tag.** Gate T4 specs behind an env flag (e.g.
   `MINDSTREAM_E2E_BACKEND=1`) so the suite skips cleanly when no stack is up —
   the same way [e2e-flows.md](e2e-flows.md) tags network flows.

---

## 3. The real-app harness (T3/T4)

> Scaffolded in [`e2e-tests/app/`](../e2e-tests/app/) — wdio + tauri-driver config, the
> gating/seam helpers, implemented smoke coverage, and pending scenario markers.
> The rest of this section is what that harness implements (and what still needs
> finishing).

Drive the **packaged Tauri binary** with `tauri-driver` (WebDriver) under a
headless display (`xvfb` on Linux CI). Build it with `--features e2e-data-dir`
so the test seams below work in a release binary.

On Linux, `tauri-driver` delegates to WebKitWebDriver. Debian/Ubuntu packages
it as `webkit2gtk-driver`; Fedora 43+ packages `/usr/bin/WebKitWebDriver` in
`webkitgtk6.0`:

```sh
sudo dnf install webkitgtk6.0
which WebKitWebDriver
```

- **Per-test data isolation & restart.** Set `MINDSTREAM_PROFILE_DIR` to a temp
  dir per test (and optionally `MINDSTREAM_PROFILE_ID` to namespace the keyring
  entry). This is the `dir_override` seam in `src-tauri/src/profiles.rs`, gated
  to dev builds and `e2e-data-dir` — a shipped production binary can never be
  redirected. Quitting and relaunching against the **same** dir is how the
  restart assertions work.
- **Native dialogs.** File/folder pickers (export, import, PDF import) can't be
  clicked over WebDriver — stub or pre-seed the path via a test hook rather than
  driving the OS widget.
- **macOS native shell checks.** Native menu-bar, Dock, and window-decoration
  flows must run on a macOS runner or a real tester machine. Linux `xvfb`
  can prove Tauri IPC flows, but it cannot prove App menu semantics, traffic
  lights, Dock reopen behaviour, or focused-window routing through the macOS
  menu bar.
- **Server URL / session injection.** For T4, prefer seeding the server URL (and
  ideally a pre-authenticated Etebase session blob + key) into the profile dir
  before launch over typing into Settings each run. If no such hook exists yet,
  add one as part of the backend harness; until then, drive the Account UI once
  per session.

---

## 4. Scenarios for the shipped history features

Run each per note kind — **markdown, freeform, ink, PDF** — because the restore
mechanism differs per kind (see [known-limitations.md](known-limitations.md)).

### T3 — single client, real backend not required

1. **Capture.** Edits produce versions on idle / note-close / History refresh;
   identical content dedups to a no-op.
2. **Restore round-trip.** Restore an older version → live content is replaced →
   a `reverted` entry appears → the pre-restore **checkpoint** version exists
   immediately before it.
3. **Undo affordance.** After a restore, the Undo control returns the note to its
   pre-restore state — and **survives a tree/sync refresh** that rebuilds
   `notesById` (the regression the bridge-store fix addressed; a component-local
   banner would have been wiped).
4. **Editor-undo isolation.** After a restore, `Ctrl+Z` does **not** revert the
   restore — assert per kind, with PDF and ink as the load-bearing cases (they
   previously leaked the restore onto the native undo stack).
5. **Persistence across restart.** Versions, `reverted` labels, and the
   denormalised `ref_created` survive a quit/relaunch against the same profile
   dir.

### T4 — two clients, shared note (the collaboration matrix)

Two app instances (two profile dirs) signed into the same test account, both
open on the same note in a shared collection:

1. **Edit propagation.** Edit in A → appears in B.
2. **Restore propagation.** Restore in A → B converges on the restored content.
3. **Concurrency (pins the limitation).** A restores while B holds a concurrent,
   not-yet-synced edit → assert the **documented** merge outcome (B's concurrent
   object/stroke additions survive as orphans; markdown currently converges to
   the restored body and may overwrite a paused text edit). This test exists
   specifically to catch a _change_ in the non-transactional-restore behaviour,
   not to assert it's clean.
4. **Undo propagation.** Undo the restore in A → B converges back.
5. **Offline / reconnect.** Toggle A offline, edit both, reconnect → assert
   convergence.

### T4 — sync, two devices, sequential (not concurrent)

Device A edits/restores → push → Device B pulls → assert the **content** matches,
**and assert B has no `reverted` timeline entry** for A's restore. That negative
assertion is the regression guard for the _history-is-per-device_ limitation.

---

## 5. Scenarios for planned features (write alongside the feature)

- **Collab confirmation prompt.** `peerCount` is now plumbed through the bridge
  for the awareness-based editors (markdown/PDF) and checked in
  `NoteHistorySection.applyRestore`: with a second client present, a restore
  shows the confirmation; solo editing does not prompt. The T4 spec asserts both
  per kind — including that ink/freeform do **not** prompt yet (their providers
  don't report presence; see [known-limitations.md](known-limitations.md)).
  (T4 — needs two clients + presence.)
- **User profiles / multi-vault.** Switching the active profile isolates history
  and data; a restart picks up the active profile. The `MINDSTREAM_PROFILE_DIR`
  seam already underpins this — these tests exercise the in-app switch on top of
  it. (T3 for isolation; restart assertion as in §4.)
- **Collection sharing (manifest bundles).** The catalogue is
  [e2e-flows.md](e2e-flows.md) §4. **All T4** — every flow is Etebase network IO
  and the meaningful ones need two distinct accounts (sender + recipient, §2.1).
  Provision two apps (two profile dirs) signed into two different test users on
  the same backend, then drive: sender creates a share (4.1) → recipient sees
  **one** `share-bundle` notification, not four raw invites (4.2) → accept adds
  the shared root and doesn't re-appear on rescan (4.3) → a separate share, when
  declined, leaves the manifest collection and does **not** loop back (4.4). The
  core 4.7 assertion creates notes/folders/assets under the accepted share,
  moves an existing vault note into it, asserts B pulls all of them without a
  re-invite, and verifies a read-write recipient edit syncs back to A. The 4.7b
  assertion moves that note back out to A's vault and verifies B no longer sees
  it under Shared. Remaining 4.7 coverage: render the synced markdown asset in
  the editor UI instead of only fetching the asset bytes through the app API.
  The incomplete-bundle guard (4.5) needs a share with a required part invite
  revoked server-side. The scaffolded spec is
  [`e2e-tests/app/specs/sharing.e2e.ts`](../e2e-tests/app/specs/sharing.e2e.ts).

---

## 6. Suggested CI shape

| Job           | Tier | When               | Needs                                    |
| ------------- | ---- | ------------------ | ---------------------------------------- |
| `unit`        | T1   | every push         | nothing                                  |
| `e2e-browser` | T2   | every push         | Node only                                |
| `e2e-app`     | T3   | every push (or PR) | packaged binary + `tauri-driver` + xvfb  |
| `e2e-collab`  | T4   | nightly / labelled | the above **+** `backend/` compose stack |

Keep T4 off the every-push path: it's the slowest and the only tier that needs
Docker and a network peer. Tagging it (`MINDSTREAM_E2E_BACKEND`) lets the same
specs run locally on demand and skip when the stack isn't up.

---

## 7. Open gaps to make this runnable

Tracked here so the strategy isn't mistaken for working infrastructure:

- [x] **Health gating landed** (§2.2): `e2e-tests/backend/backend-health.spec.ts` +
      `e2e-tests/backend/playwright.config.ts`, run via `pnpm test:e2e:backend`, gated on
      `MINDSTREAM_E2E_BACKEND`. This is the only T4-adjacent piece runnable today.
- [~] **`tauri-driver` harness scaffolded** in [`e2e-tests/app/`](../e2e-tests/app/) (wdio
  config, capability gating, the `MINDSTREAM_PROFILE_DIR` restart seam, and
  focused T3/T4 specs), run via `pnpm test:e2e:app` for T3 and
  `pnpm test:e2e:app:multi` for T4. Still needs: a native-dialog stub,
  `trashed_at` backdating, and the remaining pending T4 scenario bodies — see
  [`e2e-tests/app/README.md`](../e2e-tests/app/README.md).
- [x] **Two-client multiremote validated** (§5): `e2e-tests/app/wdio.multiremote.conf.ts`
      spawns two tauri-driver processes → `browserA`/`browserB`, run via
      `pnpm test:e2e:app:multi`. Confirmed live: both packaged apps launch and are
      driven independently against the disposable stack.
- [x] **Disposable test stack landed** (§2.1): `backend/docker-compose.test.yml`
  - `.env.test` + `pnpm backend:test:{up,down,reset}` give an isolated backend
    with `AUTO_SIGNUP=true` on a separate port (18080).
- [x] **Test-account provisioning validated** (§2.1): `e2e-tests/app/helpers/accounts.ts`
      (`provisionTwoAccounts`) signs up two distinct users via the `etebase` JS SDK.
      It provisions a fresh pair by default so suites do not inherit remote vault,
      invite, notification, or seed-note state from an old still-running stack.
      Set `MINDSTREAM_E2E_REUSE_ACCOUNTS=1` to opt into the gitignored
      `.t4-accounts.json` cache while iterating locally.
- [ ] No test hook to inject a pre-authenticated session blob (§3) — specs log in
      via the app's own `etebase_login` for now.
- [x] **First T4 app assertions landed**: `sync-history.e2e.ts` covers the
      per-device-history negative assertion; `sharing.e2e.ts` covers manifest
      bundle flows 4.1–4.4, the core 4.7 subtree/asset convergence path, and
      4.7b move-out re-home; `sync-history.e2e.ts` also covers 4.10
      edit-wins-over-delete for plain vault notes; `collab.e2e.ts` and
      `collab-confirm.e2e.ts` keep the live relay / peer prompt cases as pending
      markers until the packaged WebKit harness has a deterministic readiness
      signal.
- [~] **`peerCount` bridge method landed** for the awareness-based editors
  (markdown/PDF) and the collab-confirmation prompt is wired in
  `NoteHistorySection`. Remaining: ink/freeform presence plus their T4
  prompt assertions (see [known-limitations.md](known-limitations.md)).

## 8. Findings from live T4 runs

Observations from actually running `pnpm test:e2e:app:multi` against the
disposable stack. These are **harness/tooling gotchas**, not app bugs — the app
behaved correctly in each case; the WebDriver layer needed adapting. Logged here
so they aren't rediscovered.

- **WebKitWebDriver (Linux `wry`) rejects native input commands.** `element/click`
  and send-keys come back as `unsupported operation`. Every interaction must be
  synthesized as DOM events via `browser.execute` / `client.execute` — this is
  why `harness.ts` clicks by dispatching `mousedown`/`mouseup`/`click` and fills
  by assigning `.value` + dispatching `input`/`change`. Any new helper must go
  through `execute`, never `el.click()` / `el.setValue()`. (macOS/Windows
  WebViews may accept the native path, but the synthesized path is portable.)
- **Label-wrapped inputs resolve `aria/<name>` to the `<label>`, not the field.**
  The Settings sign-in inputs are `<label><span>Server URL</span><input/></label>`
  (SignInForm.svelte) with no explicit `aria-label` on the control, so the
  accessible name attaches to the wrapping `<label>`. `client.$('aria/Server URL')`
  returned the label and `.value =` on it was a silent no-op — the symptom was
  "navigated to the form but filled nothing". `setValue` now drills to a
  descendant `input, textarea, select` before assigning. Not an app bug, but a
  mild a11y smell: adding `aria-label`/`id`+`for` to these controls would make
  them unambiguous for assistive tech and tooling alike.
- **Multiremote fans globals out to both clients.** The module-level `aria/`
  helpers act on every browser at once; per-client work must go through
  `clientHelpers(client)` (or the client instance directly). `loginClient` runs
  under `Promise.all`, so an error in either client surfaces as `Promise.all
(index N)`.
- **Skips are environment gates, not hidden passing coverage.** The T4 specs now
  keep implemented scenarios active. Current validated app assertions cover
  collab propagation, restore convergence, restore confirmation, reconnect
  convergence, sharing flows 4.1–4.7b, the owner-second-device 4.8–4.9 re-home
  cases in `sharing-multi-device.e2e.ts`, and 4.10 edit-wins-over-delete for
  plain vault notes. Remaining skips are limited to harness gates for packaged
  app/backend/native-dialog availability.
