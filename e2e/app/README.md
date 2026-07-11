# Real-app e2e (T3) + collaboration (T4)

This directory drives the **packaged Tauri binary** over WebDriver
(`tauri-driver`) — the T3/T4 tiers in
[e2e-strategy.md](../../docs/e2e-strategy.md).
It is separate from the Playwright browser-fallback suite in `../browser/` and
**never runs in the default `pnpm test:e2e` or in CI**.

> **Status:** The T3 harness runs against the packaged app when the opt-in
> toolchain below is installed. T4 and native-dialog flows still skip cleanly
> until their environment-specific seams are wired: multiremote two-client
> setup, a native-dialog stub, and `trashed_at` backdating.

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
| `specs/sharing.e2e.ts`          | T4   | collection sharing flows 4.1–4.10 (two distinct accounts)              |

`helpers/harness.ts` owns the capability gating, the `MINDSTREAM_PROFILE_DIR`
isolation/restart seam, and the accessible-name selectors (the same names the
Playwright T2 specs use — the identical SvelteKit UI renders inside the
WebView). `helpers/backend.ts` is the T4 backend-readiness gate.

## Toolchain

```sh
# Rust: the WebDriver bridge + a platform webdriver
cargo install tauri-driver
#   Windows: install msedgedriver matching your WebView2 (Edge) version
#   Debian/Ubuntu: apt-get install webkit2gtk-driver
#   Fedora 43+:    dnf install webkitgtk6.0
#
# Verify Linux WebKitWebDriver is installed:
#   which WebKitWebDriver

# npm: the wdio runner dependencies are installed through pnpm install.
```

## Run

```sh
# T3 (single client). Builds the binary with --features e2e-data-dir first;
# set MINDSTREAM_E2E_SKIP_BUILD=1 to reuse a build while iterating.
MINDSTREAM_E2E_APP=1 pnpm test:e2e:app

# T4 (collaboration) also needs the backend stack up:
#   cd backend && docker compose up -d --build
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
- **Two distinct accounts (sharing, T4):** `sharing.e2e.ts` needs a sender and a
  recipient — two real Etebase signups on the same backend, not one account on
  two devices (the sender must resolve the recipient's pubkey via
  `fetch_user_profile`). Needs the two-account provisioning seam in
  e2e-strategy.md §2.1 on top of multiremote.
