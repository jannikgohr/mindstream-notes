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
   (`docker compose logs etebase | grep -i password`).
2. **Health gating.** Block tests until the stack is ready: nginx `/healthz`,
   a TCP connect to yjs-relay `:1234`, the excalidraw-room socket.io handshake,
   and Etebase accepting connections (the compose healthchecks already encode
   each probe — reuse them).
3. **Isolation & teardown.** A disposable Postgres volume per run (or per-run
   collections plus cleanup) so state never leaks between runs.
4. **Capability tag.** Gate T4 specs behind an env flag (e.g.
   `MINDSTREAM_E2E_BACKEND=1`) so the suite skips cleanly when no stack is up —
   the same way [e2e-flows.md](e2e-flows.md) tags network flows.

---

## 3. The real-app harness (T3/T4)

Drive the **packaged Tauri binary** with `tauri-driver` (WebDriver) under a
headless display (`xvfb` on Linux CI). Build it with `--features e2e-data-dir`
so the test seams below work in a release binary.

- **Per-test data isolation & restart.** Set `MINDSTREAM_PROFILE_DIR` to a temp
  dir per test (and optionally `MINDSTREAM_PROFILE_ID` to namespace the keyring
  entry). This is the `dir_override` seam in `src-tauri/src/profiles.rs`, gated
  to dev builds and `e2e-data-dir` — a shipped production binary can never be
  redirected. Quitting and relaunching against the **same** dir is how the
  restart assertions work.
- **Native dialogs.** File/folder pickers (export, import, PDF import) can't be
  clicked over WebDriver — stub or pre-seed the path via a test hook rather than
  driving the OS widget.
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
   addition survives as an orphan; markdown merges at boundaries). This test
   exists specifically to catch a _change_ in the non-transactional-restore
   behaviour, not to assert it's clean.
4. **Undo propagation.** Undo the restore in A → B converges back.
5. **Offline / reconnect.** Toggle A offline, edit both, reconnect → assert
   convergence.

### T4 — sync, two devices, sequential (not concurrent)

Device A edits/restores → push → Device B pulls → assert the **content** matches,
**and assert B has no `reverted` timeline entry** for A's restore. That negative
assertion is the regression guard for the _history-is-per-device_ limitation.

---

## 5. Scenarios for planned features (write alongside the feature)

- **Collab confirmation prompt.** Once `peerCount` is plumbed through the bridge:
  with a second client present, a restore shows the confirmation; solo editing
  does not prompt. (T4 — needs two clients + presence.)
- **User profiles / multi-vault.** Switching the active profile isolates history
  and data; a restart picks up the active profile. The `MINDSTREAM_PROFILE_DIR`
  seam already underpins this — these tests exercise the in-app switch on top of
  it. (T3 for isolation; restart assertion as in §4.)

---

## 6. Suggested CI shape

| Job          | Tier | When               | Needs                                    |
| ------------ | ---- | ------------------ | ---------------------------------------- |
| `unit`       | T1   | every push         | nothing                                  |
| `e2e-web`    | T2   | every push         | Node only                                |
| `e2e-app`    | T3   | every push (or PR) | packaged binary + `tauri-driver` + xvfb  |
| `e2e-collab` | T4   | nightly / labelled | the above **+** `backend/` compose stack |

Keep T4 off the every-push path: it's the slowest and the only tier that needs
Docker and a network peer. Tagging it (`MINDSTREAM_E2E_BACKEND`) lets the same
specs run locally on demand and skip when the stack isn't up.

---

## 7. Open gaps to make this runnable

Tracked here so the strategy isn't mistaken for working infrastructure:

- [ ] No `tauri-driver` harness wired yet (T3/T4 backlog per
      [e2e-flows.md](e2e-flows.md)).
- [ ] No automated test-account provisioning against Etebase (§2.1).
- [ ] No test hook to inject the server URL / a pre-authenticated session (§3).
- [ ] `peerCount` bridge method not implemented — blocks the collab-confirmation
      tests and the feature itself (see [known-limitations.md](known-limitations.md)).
