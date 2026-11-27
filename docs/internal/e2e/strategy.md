# End-to-end test tiers

How to pick the tier for a test. Commands are in
[e2e-tests/README.md](../../../e2e-tests/README.md); the flows and their
coverage are in [flows.md](flows.md).

The unit suites (`vitest`, `cargo test`) cover the logic. What they exclude,
the Tauri IPC boundary, sync over the network, native dialogs and the file
system, the editor and canvas frameworks, and persistence across a restart,
only means something when the whole stack runs.

## The four tiers

| Tier                          | Runs                                       | Backs the API with                   | Proves                                                                            |
| ----------------------------- | ------------------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------- |
| **T1 Unit**                   | `pnpm test`, `cargo test`                  | n/a (pure logic)                     | dedup, deltas, compression, doc model, restore math                               |
| **T2 Browser-fallback**       | `pnpm test:e2e` (Playwright)               | in-memory mock store                 | pure-UI journeys: history list, restore button states, Undo banner, action labels |
| **T3 Single-client Tauri**    | `tauri-driver` on the packaged app         | real Rust + SQLite + disk            | the real capture/restore/undo round-trip + persistence across restart             |
| **T4 Multi-client + backend** | two `tauri-driver` apps + the test backend | the real sync server, rooms included | sync convergence and live-collab restore semantics                                |

Test a feature at the **lowest tier that can prove it**. The Undo banner
rendering is T2, because the mock store implements `captureCurrentNoteVersion`.
The Undo round-trip through SQLite is T3. "Undo on device A converges on
device B" is T4.

T3 and T4 drive the packaged binary, see [harness.md](harness.md). T4 also
needs the [test backend](backend-stack.md).

Browser WebKit runs the importer dialog tests next to Chromium. It complements
the packaged Linux app, which runs on WebKitGTK; it does not stand in for it.

## In CI

`.github/workflows/test.yml` runs on pushes to `main` and on PRs:

| Job             | Tier  | Runs on                 | Needs                                          |
| --------------- | ----- | ----------------------- | ---------------------------------------------- |
| `js`            | T1    | Linux + Windows + macOS | Node only                                      |
| `rust`          | T1    | Linux + Windows + macOS | Rust                                           |
| `coverage`      | T1    | Linux                   | Node + Rust                                    |
| `e2e`           | T2    | Linux                   | Node only                                      |
| `app-e2e-build` | T3/T4 | Linux                   | Rust + Tauri system dependencies               |
| `app-e2e`       | T3/T4 | Linux + Xvfb            | packaged build + native driver; backend for T4 |

Code changes run T1 on all three desktop systems. Ready code PRs also run T2
and T3; draft PRs skip both. T4 runs for collaboration changes, pushes to
`main` and overrides. The `ci:app-e2e` label or a manual workflow run enables
every suite, drafts and docs-only changes included. Other labels don't rerun
the tests. `src-tauri/scripts/ci-test-plan.mjs` makes these decisions.

## Android is not a tier yet

All four tiers run on the desktop or in a headless browser. The mobile specs in
`e2e-tests/browser/` give desktop Chromium an Android user agent and viewport,
so they prove mobile layout, not Android. Nothing runs on an Android runtime,
and `tauri-driver` cannot drive one. [flows.md](flows.md#7-android) sets out
what an Android tier would take.
