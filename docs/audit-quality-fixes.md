# September audit: tree loading and quality gates

Reviewed against `3ad615a` on 2026-09-07. This branch addresses the following
findings from `docs/audit-2026-09.md`.

| Finding | Disposition and evidence                                                                                                                                                                                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H2      | Type-aware promise rules now cover `.svelte` and `.svelte.ts`. Fixed nine floated component calls with rejection handlers. Uncaught errors and rejections reach the native log through `report_client_error`, with bounded messages and handled reporting failures. Runtime reporter tests cover cleanup and failure.                                                                |
| H5      | `load_tree` returns folders and note summaries from one SQLite transaction under one database lock. IPC tests assert one command and reject malformed results. Rust tests cover nested and trashed notes and body-free summaries.                                                                                                                                                    |
| H6      | Calls during a read request a subsequent snapshot and await it. An older snapshot cannot overwrite the pending reload. Tests interleave mutations, reads, and failed reads.                                                                                                                                                                                                          |
| M2      | Removed non-fatal coverage steps and advisory Codecov statuses. Added the missing Rust `--fail-under-lines 80` gate. Frontend coverage now includes editor plugins, collaboration providers, desktop controllers, and vendored Kanban logic. The 80% line threshold remains unchanged. Rendering and native bridges remain outside the TypeScript metric and have separate E2E jobs. |
| M3      | Added a Linux CI matrix for all three WDIO configurations, with Tauri builds, WebKitWebDriver, Xvfb, a session keyring, disposable T4 backend, cleanup, and log artifacts. These jobs fail on test or environment errors. Their first Linux execution is verified by the draft PR workflow, not by the Windows unit run.                                                             |
| M6      | The zero-test claim was partly stale: `mobile-card-drag.test.ts` already tested vendored drag helpers. Added seven interaction tests in the package covering real drop, read-only behavior, Escape, cancellation, teardown, and pending touch hold. Package TypeScript now contributes to coverage.                                                                                  |
| M7      | Note title, tag, and favourite updates already avoided full reloads. Creation, PDF import, single-note moves, folder creation, and folder rename now apply returned metadata too. Tests assert no full-vault reload for a single move or rename. Subtree and sync operations still reload one consistent snapshot.                                                                   |
| L6      | The translation check validates interpolation names and multiplicity, string values, and exact reviewed identical translations. The existing legitimate identical German strings form a value-specific allowlist. Four script tests cover missing/extra keys, renamed/missing/duplicated placeholders, and untranslated regressions.                                                 |

## Validation

- Frontend: 2,805 tests passed across 222 files; 82.19% line coverage after expanding the denominator.
- Rust: formatting, Clippy for all targets with warnings denied, 572 unit tests and one integration test passed. Two pre-existing environment-dependent tests remain ignored: the Windows symlink test and the external LanguageTool contract test.
- Translation checker and its four tests passed.
- Repository ESLint passed with the expanded component rules.
- Svelte type check and production build passed.

The original audit's line counts and assertion counts describe an earlier
snapshot. Test counts here are runner results for this branch, not assertion
counts or a claim of full rendering coverage.
