# E2E testing strategy: tiers & rationale

**Just want to run the tests?** See [e2e-tests/README.md](../../e2e-tests/README.md).
This doc is the _why_: the test tiers and how to pick one.

The unit suites (`vitest`, `cargo test`) cover the logic layer, with coverage
reported to Codecov. Everything they exclude — the Tauri IPC boundary, Etebase
network sync, native dialogs and the file system, the editor/canvas frameworks,
cross-restart persistence — only has meaning when the whole stack runs together.
That integration surface is the e2e backlog, catalogued in [flows.md](flows.md).

Note-history made this unavoidable: version restore, the cross-device timeline,
live-collab restore propagation, and the collab-confirmation guard are each a
_multi-process, multi-device interaction_. A mock store cannot prove any of them.

## The four tiers

| Tier                          | Runs                                       | Backs the API with                         | Proves                                                                            |
| ----------------------------- | ------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------- |
| **T1 Unit**                   | `pnpm test`, `cargo test`                  | n/a (pure logic)                           | dedup, deltas, compression, doc model, restore math                               |
| **T2 Browser-fallback**       | `pnpm test:e2e` (Playwright)               | in-memory mock store                       | pure-UI journeys: history list, restore button states, Undo banner, action labels |
| **T3 Single-client Tauri**    | `tauri-driver` on the packaged app         | real Rust + SQLite + disk                  | the real capture/restore/undo round-trip + persistence across restart             |
| **T4 Multi-client + backend** | two `tauri-driver` apps + the test backend | real Etebase + yjs-relay + excalidraw-room | sync convergence and live-collab restore semantics                                |

Test a feature at the **lowest tier that can actually prove it**: the Undo
_banner rendering_ is T2 (the mock store implements `captureCurrentNoteVersion`
et al.); the Undo _round-trip through SQLite_ is T3; "undo on device A converges
on device B" is T4.

- T2 runs the SvelteKit SPA in browser-fallback mode — see [flows.md](flows.md)
  for the journeys it already covers (`e2e-tests/browser/`).
- T3/T4 drive the packaged binary — see [harness.md](harness.md).
- T4 additionally needs the [backend stack](backend-stack.md).

## CI shape

### In CI today (`.github/workflows/test.yml`, on push to `main` + PRs)

| Job        | Tier | Runs on                 | Needs       |
| ---------- | ---- | ----------------------- | ----------- |
| `js`       | T1   | Linux + Windows + macOS | Node only   |
| `rust`     | T1   | Linux + Windows + macOS | Rust        |
| `coverage` | T1   | Linux                   | Node + Rust |
| `e2e`      | T2   | Linux                   | Node only   |

**T3 and T4 do not run in CI yet** — no `e2e-app`/`e2e-collab` job exists in
`test.yml`, and `release.yml` runs no e2e at all. Both tiers are **local/manual
only** for now (`MINDSTREAM_E2E_*` flags, run on demand). This is the biggest
open gap; see [status.md](status.md).

### Where they should run (proposal)

| Tier | Suggested trigger  | Needs                                     |
| ---- | ------------------ | ----------------------------------------- |
| T3   | every PR / push    | packaged binary + `tauri-driver` + xvfb   |
| T4   | **release** (tags) | the above **+** the backend compose stack |

T4 belongs on the release path, not every push: it's the slowest tier and the
only one needing Docker and a network peer, so gating a release on it (rather
than running it nightly or per-push) catches sync/collab regressions before they
ship without taxing routine PRs. The `MINDSTREAM_E2E_*` env flags already let the
same specs skip cleanly when their prerequisites aren't up, so wiring them in is
a workflow change, not a spec change.

Current coverage and the open gaps are tracked in [status.md](status.md).
