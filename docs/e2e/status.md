# E2E coverage & open gaps

What the real-app suite ([e2e-tests/app/](../../e2e-tests/app/)) actually
asserts today, and what's still stubbed. The flow catalogue is [flows.md](flows.md);
this is the state of its implementation. **Skips are environment gates, not
hidden passing coverage** — a run's pass count reflects implemented scenarios.

## What's landed

| Spec                          | Tier | Covers                                                                 |
| ----------------------------- | ---- | ---------------------------------------------------------------------- |
| `editor-roundtrip.e2e.ts`     | T3   | flow 1.1 through real `save_note` + SQLite + restart                   |
| `history.e2e.ts`              | T3   | capture / restore / Undo / editor-undo isolation / restart persistence |
| `trash-retention.e2e.ts`      | T3   | flows 1.5 + 3.3 (retention sweep on boot)                              |
| `settings-persist.e2e.ts`     | T3   | flows 3.1 / 3.2                                                        |
| `sync-history.e2e.ts`         | T4   | per-device-history negative assertion; 4.10 edit-wins-over-delete      |
| `sharing.e2e.ts`              | T4   | sharing flows 4.1–4.4 + core 4.7 subtree/asset convergence + 4.7b      |
| `sharing-multi-device.e2e.ts` | T4   | owner-second-device 4.8–4.9 re-home cases                              |

Validated app assertions cover collab propagation, restore convergence, restore
confirmation, reconnect convergence, sharing 4.1–4.7b, and edit-wins-over-delete
for plain vault notes.

## What's pending

| Spec                    | Blocked on                                                                      |
| ----------------------- | ------------------------------------------------------------------------------- |
| `collab.e2e.ts`         | markdown live-edit propagation — needs a deterministic Yjs relay/readiness hook |
| `collab-confirm.e2e.ts` | ink/freeform restore prompt — their providers don't report presence yet         |
| `backup.e2e.ts`         | flows 1.2–1.4 — need the native-dialog path-injection hook                      |

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
