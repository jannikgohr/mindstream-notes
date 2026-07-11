# Real-app e2e (T3) + collaboration (T4)

This directory drives the **packaged Tauri binary** over WebDriver
(`tauri-driver`) — the T3/T4 tiers in
[e2e-strategy.md](../../docs/e2e-strategy.md).
It is separate from the Playwright browser-fallback suite in `../browser/` and
**never runs in the default `pnpm test:e2e` or in CI**.

> **Status:** The T3 harness runs against the packaged app when the opt-in
> toolchain below is installed. The T4 multiremote harness and two-account
> provisioning have been validated against the disposable stack. T4 now has
> real assertions for markdown live-edit propagation, per-device history sync,
> markdown restore confirmation, and sharing flows 4.1–4.4; the remaining T4
> backlog is marked pending. Native-dialog flows still skip cleanly until their
> Rust-side path-injection seam is wired.

## What's here

| File                            | Tier | Covers (docs/e2e-flows.md / e2e-strategy.md §4–5)                      |
| ------------------------------- | ---- | ---------------------------------------------------------------------- |
| `specs/history.e2e.ts`          | T3   | capture / restore / Undo / editor-undo isolation / restart persistence |
| `specs/editor-roundtrip.e2e.ts` | T3   | flow 1.1 through real save_note + SQLite + restart                     |
| `specs/trash-retention.e2e.ts`  | T3   | flow 1.5 + 3.3 (retention sweep on boot)                               |
| `specs/settings-persist.e2e.ts` | T3   | flow 3.1 / 3.2                                                         |
| `specs/backup.e2e.ts`           | T3   | flows 1.2 / 1.3 / 1.4 (needs a native-dialog hook)                     |
| `specs/collab.e2e.ts`           | T4   | markdown live-edit propagation; remaining matrix cases pending         |
| `specs/sync-history.e2e.ts`     | T4   | per-device-history negative assertion                                  |
| `specs/collab-confirm.e2e.ts`   | T4   | markdown restore prompt + solo no-prompt; ink/freeform pending         |
| `specs/sharing.e2e.ts`          | T4   | collection sharing flows 4.1–4.4; 4.5–4.10 pending                     |

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

# T4 (collaboration) also needs the disposable backend stack up:
pnpm backend:test:up
MINDSTREAM_E2E_APP=1 MINDSTREAM_E2E_BACKEND=1 \
  MINDSTREAM_E2E_BACKEND_URL=http://localhost:18080 pnpm test:e2e:app:multi
```

Without `MINDSTREAM_E2E_APP=1`, every spec skips. The T4 specs run through the
multiremote config and additionally require `MINDSTREAM_E2E_BACKEND=1`; the
dialog-driven backup specs require `MINDSTREAM_E2E_DIALOG_HOOK=1` once that Rust
seam exists.

## Two-client (T4) harness

- **Multiremote config landed:** `wdio.multiremote.conf.ts` spawns **two**
  tauri-driver processes (ports 4444/4445 and 4446/4447), each launching the app
  against its own `MINDSTREAM_PROFILE_DIR`, and drives them as `browserA` /
  `browserB`. Run with `pnpm test:e2e:app:multi` (backend up + the T4 env flags).
- **Two-account provisioning landed:** `helpers/accounts.ts`
  (`provisionTwoAccounts`) signs up a distinct sender + recipient via the
  `etebase` JS SDK — real signups so the sender resolves the recipient's pubkey
  via `fetch_user_profile`. Needs the test stack's `AUTO_SIGNUP=true`
  (`pnpm backend:test:up`); Etebase blocks signup by default.
- **Validated live:** the two tauri-driver processes launch independently
  against the disposable stack and can be driven as `browserA` / `browserB`.
  Remaining T4 backlog tests are marked pending rather than passing as empty
  bodies, so a run's pass count reflects implemented coverage.

## Open seams (see e2e-strategy.md §7)

- **Native dialogs:** export/import/PDF pickers can't be clicked over WebDriver;
  they need a Rust-side hook to pre-seed the path. `requireDialogHook` keeps
  those specs skipped until then.
- **`trashed_at` backdating:** the retention-sweep spec needs a hook to age an
  item past the retention window.
- **Session injection (optimization):** specs currently log each client in
  through the app's own `etebase_login` (drives Account UI / IPC). Seeding a
  pre-authenticated session blob into each profile dir (e2e-strategy.md §3) would
  skip that per run but needs a Rust-side hook.
