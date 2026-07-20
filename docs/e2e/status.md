# E2E coverage & open gaps

What the real-app suite ([e2e-tests/app/](../../e2e-tests/app/)) actually
asserts today, and what's still stubbed. The flow catalogue is [flows.md](flows.md);
this is the state of its implementation. **Skips are environment gates, not
hidden passing coverage** — a run's pass count reflects implemented scenarios.

## What's landed

| Spec                          | Tier | Covers                                                                                        |
| ----------------------------- | ---- | --------------------------------------------------------------------------------------------- |
| `editor-roundtrip.e2e.ts`     | T3   | flow 1.1 through real `save_note` + SQLite + restart                                          |
| `history.e2e.ts`              | T3   | capture / restore / Undo / editor-undo isolation / restart persistence                        |
| `trash-retention.e2e.ts`      | T3   | flows 1.5 + 3.3 (retention sweep on boot)                                                     |
| `settings-persist.e2e.ts`     | T3   | flows 3.1 / 3.2                                                                               |
| `sync-history.e2e.ts`         | T4   | per-device-history negative assertion; 4.10 edit-wins-over-delete                             |
| `sharing.e2e.ts`              | T4   | sharing flows 4.1–4.4 + core 4.7 subtree/asset convergence + 4.7b                             |
| `sharing-multi-device.e2e.ts` | T4   | owner-second-device 4.8–4.9 re-home cases                                                     |
| `collab.e2e.ts`               | T4   | live markdown propagation, restore convergence, restore-vs-paused-peer, reconnect convergence |

Validated app assertions cover live collab propagation, restore convergence,
reconnect convergence, seeded-note convergence, sharing 4.1–4.7b, and
edit-wins-over-delete for plain vault notes.

## Previously red, now fixed — 2026-07-20

A full local run of every tier found three specs failing. All three are green
again; each had a different cause, and only one was a product bug.

| Spec             | Cause                                                                                                                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `history.e2e.ts` | **Product bug.** A restore landed on the editor's undo stack, so Ctrl+Z rolled it back — and, since a restore is an ordinary CRDT edit, that rollback reached every connected peer. Fixed with `addToHistory: false`.                                           |
| `sharing.e2e.ts` | **Stale selector.** The share dialog gained comma-separated multi-user invites and its label became `Users`. One stale label failed 6 of 8 assertions: the first failure left a modal open, so later tests timed out on the folder or the Sharing menu instead. |
| `collab.e2e.ts`  | **Stale assertion**, plus contention in the `before all` hook. The assertion expected a restore to clobber a paused peer's concurrent edit — true when written, before `minimalDocDiff` narrowed a restore to the range the restorer actually diffed.           |

### Residual: an intermittent launch flake in the T4 multi run

Every one of the 21 assertions across the five `wdio.multiremote.conf.ts` specs
passes when its spec runs alone. A full five-spec run is _not_ yet reliable:
roughly one spec per run fails in its `before all` with
`element ("aria/Open settings") still not displayed`, and **which** spec varies
between runs.

Two things were ruled out with evidence rather than assumed:

- **Not the auth rate limit.** nginx logged zero 429s across 90 auth requests
  in a full run, so `limit_req` on the credential endpoints is not throttling
  the harness.
- **Not a stale SQLite lock** from the shared profile dirs. The app log shows
  clean boots — migrations run, `empty database — seeding demo content` — with
  no panic and no database error, on every spec.

What _was_ fixed: the run used to fail 3 specs on a flat 120s mocha timeout,
because each two-client `before all` does two Etebase signups plus two full UI
sign-ins. Raising it to 240s for this config took the run from 14m36 to 4m30
and from 3 failures to 1. `specFileRetries` was deliberately not added — it
would hide exactly this kind of flake.

Still open: the webview occasionally not being ready within the helper's 30s
window at session start. Root cause unknown.

Two things worth carrying forward:

- **A cascading first failure hides its own cause.** Both T4 specs reported
  timeouts several assertions downstream of the real break. Running a single
  test in isolation (`--mochaOpts.grep`) surfaced it immediately.
- **The relay container must match the client.** A stack rebuilt from a
  different commit leaves the relay without the join challenge, and the client
  then hangs waiting for one. Symptoms look like app bugs. `docker exec
mindstream-test-yjs-relay grep -c mindstream-collab-join /app/collab-server.mjs`
  tells you which you have.

## What's pending

| Spec                    | Blocked on                                                              |
| ----------------------- | ----------------------------------------------------------------------- |
| `collab-confirm.e2e.ts` | ink/freeform restore prompt — their providers don't report presence yet |
| `backup.e2e.ts`         | flows 1.2–1.4 — need the native-dialog path-injection hook              |

The collab-confirmation prompt (`peerCount` in `NoteHistorySection`) is wired
and asserted for the awareness-based editors (markdown/PDF); ink/freeform stay
pending because their providers don't report presence (see
[known-limitations.md](../known-limitations.md)).

## Open gaps

- [ ] **T3/T4 aren't wired into CI.** `test.yml` runs only T1 (`js`, `rust`,
      `coverage`) and T2 (`e2e`); `release.yml` runs no e2e. The real-app suites
      are local/manual only. The plan ([strategy.md](strategy.md#ci-shape)) is
      T3 per PR and T4 on release — a workflow change, since the specs already
      gate themselves on `MINDSTREAM_E2E_*`.
- [ ] **Native-dialog hook.** Export/import/PDF pickers can't be driven over
      WebDriver; a Rust-side hook to pre-seed the path would unskip `backup.e2e.ts`
      and the PDF flows.
- [ ] **`trashed_at` backdating hook.** The retention-sweep spec needs a way to
      age an item past the retention window.
- [ ] **Session-injection hook.** Specs log in via the app's own `etebase_login`
      each run; seeding a pre-authenticated session blob would skip that (see
      [harness.md](harness.md)).
- [ ] **Deterministic relay/presence readiness** for the packaged WebKit harness
      — unblocks live markdown propagation and ink/freeform presence prompts.
- [ ] **Render synced markdown assets in the editor UI** (4.7) — currently only
      the asset bytes are fetched through the app API.
- [ ] **Incomplete-bundle guard (4.5)** — needs a share with a required part
      invite revoked server-side.
