# Real-app e2e (T3) + collaboration (T4)

This directory drives the **packaged Tauri binary** over WebDriver
(`tauri-driver`) — the T3/T4 tiers in [../docs/e2e-strategy.md](../docs/e2e-strategy.md).
It is separate from the Playwright browser-fallback suite in `../e2e/` and
**never runs in the default `pnpm test:e2e` or in CI**.

> **Status: scaffold.** The harness, config, and faithful spec skeletons are in
> place and gated to skip cleanly, but they have **not been run against a real
> binary** — they require the opt-in toolchain below plus a built app (and, for
> T4, the backend stack). Treat the spec bodies as the documented assertions to
> validate once the environment exists; several carry `TODO`s where an
> environment-specific seam (native-dialog stub, multiremote two-client setup,
> `trashed_at` backdating) still has to be wired.

## What's here

| File                            | Tier | Covers (docs/e2e-flows.md / e2e-strategy.md §4–5)                      |
| ------------------------------- | ---- | ---------------------------------------------------------------------- |
| `specs/history.e2e.ts`          | T3   | capture / restore / Undo / editor-undo isolation / restart persistence |
| `specs/editor-roundtrip.e2e.ts` | T3   | flow 1.1 through real save_note + SQLite + restart                     |
| `specs/trash-retention.e2e.ts`  | T3   | flow 1.5 + 3.3 (retention sweep on boot)                               |
| `specs/settings-persist.e2e.ts` | T3   | flow 3.1 / 3.2                                                         |
| `specs/backup.e2e.ts`           | T3   | flows 1.2 / 1.3 / 1.4 (needs a native-dialog hook)                     |
| `specs/collab.e2e.ts`           | T4   | the two-client collaboration matrix + flow 2.5                         |
| `specs/sync-history.e2e.ts`     | T4   | per-device-history negative assertion                                  |
| `specs/collab-confirm.e2e.ts`   | T4   | the collab confirmation prompt (§5)                                    |

`helpers/harness.ts` owns the capability gating, the `MINDSTREAM_PROFILE_DIR`
isolation/restart seam, and the accessible-name selectors (the same names the
Playwright T2 specs use — the identical SvelteKit UI renders inside the
WebView). `helpers/backend.ts` is the T4 backend-readiness gate.

## Toolchain (opt-in — intentionally not in the lockfile)

```sh
# Rust: the WebDriver bridge + a platform webdriver
cargo install tauri-driver
#   Windows: install msedgedriver matching your WebView2 (Edge) version
#   Linux:   apt-get install webkit2gtk-driver  (provides WebKitWebDriver)

# npm: the wdio runner (add as devDependencies when you wire this into CI)
pnpm add -D @wdio/cli @wdio/local-runner @wdio/mocha-framework \
            @wdio/spec-reporter @wdio/globals expect-webdriverio tsx
```

## Run

```sh
# T3 (single client). Builds the binary with --features e2e-data-dir first;
# set MINDSTREAM_E2E_SKIP_BUILD=1 to reuse a build while iterating.
MINDSTREAM_E2E_APP=1 pnpm test:e2e:app

# T4 (collaboration) also needs the backend stack up:
#   cd ../backend && docker compose up -d --build
MINDSTREAM_E2E_APP=1 MINDSTREAM_E2E_BACKEND=1 pnpm test:e2e:app
```

Without `MINDSTREAM_E2E_APP=1`, every spec skips. The T4 specs additionally
require `MINDSTREAM_E2E_BACKEND=1`; the dialog-driven backup specs require
`MINDSTREAM_E2E_DIALOG_HOOK=1` once that Rust seam exists.

## Open seams (see e2e-strategy.md §7)

- **Two-client (T4):** a single tauri-driver session hosts one app. The matrix
  specs need wdio **multiremote** (two capabilities) or two driver processes —
  add a `wdio.multiremote.conf.ts` alongside this config.
- **Native dialogs:** export/import/PDF pickers can't be clicked over WebDriver;
  they need a Rust-side hook to pre-seed the path. `requireDialogHook` keeps
  those specs skipped until then.
- **`trashed_at` backdating:** the retention-sweep spec needs a hook to age an
  item past the retention window.
