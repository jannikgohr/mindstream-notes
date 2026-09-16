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

| Job             | Tier  | Runs on                 | Needs                                          |
| --------------- | ----- | ----------------------- | ---------------------------------------------- |
| `js`            | T1    | Linux + Windows + macOS | Node only                                      |
| `rust`          | T1    | Linux + Windows + macOS | Rust                                           |
| `coverage`      | T1    | Linux                   | Node + Rust                                    |
| `e2e`           | T2    | Linux                   | Node only                                      |
| `app-e2e-build` | T3/T4 | Linux                   | Rust + Tauri system dependencies               |
| `app-e2e`       | T3/T4 | Linux + Xvfb            | packaged build + native driver; backend for T4 |

Code changes run T1 checks on all three desktop systems. Ready code PRs also
run T2 and native T3. Draft PRs defer E2E unless labelled `ci:app-e2e`.
T4 runs for collaboration changes, pushes to main, and explicit overrides.
Manual Test workflow runs and the `ci:app-e2e` label enable all suites.
`src-tauri/scripts/ci-test-plan.mjs` defines those decisions.

### Dialog and dependency regressions

Use `pnpm test:e2e:dialogs` for the importer lifecycle in Chromium and WebKit.
Stub native responses to reach configuration, running, failure/retry, Stop,
and immediate completion. Exercise actual keyboard focus and assert automatic
restoration after close. These tests run without retries and retain traces
and screenshots on failure. See [Bits UI maintenance](../bits-ui.md).

T3 checks the same importer with real IPC, disk, SQLite, and restart
persistence in the packaged Linux app. Browser WebKit complements this check;
it does not stand in for WebKitGTK. CI uploads bounded HTML/JSON captures,
screenshots, driver logs, and independent X11 frames for native failures.

Current coverage and the open gaps are tracked in [status.md](status.md); the
queue of tests still to write is [backlog.md](backlog.md).

### Android is not a tier yet

The four tiers above are all desktop or headless-browser. The mobile specs in
`e2e-tests/browser/` emulate an Android user-agent and viewport in desktop
Chromium — they prove mobile layout, not Android. Nothing runs on an Android
runtime, and `tauri-driver` cannot drive one. What a real Android tier would
take, and how far it can realistically go, is worked through in
[backlog.md](backlog.md#7-android).
