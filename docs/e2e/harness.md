# The real-app harness (T3/T4)

How the `e2e-tests/app/` suite drives the **packaged Tauri binary** with
`tauri-driver` (WebDriver) under a headless display (`xvfb` on Linux CI). The
binary is built with `--features e2e-data-dir` so the test seams below work in a
release build. Run commands are in [e2e-tests/README.md](../../e2e-tests/README.md);
two-client specifics are in [e2e-tests/app/README.md](../../e2e-tests/app/README.md).

## Toolchain

These tiers build and drive the packaged binary, so you first need the base
app-build toolchain (Rust + your OS's Tauri system deps) from
[docs/BUILDING.md](../BUILDING.md). On top of that:

```sh
cargo install tauri-driver          # the WebDriver bridge

# plus a platform webdriver:
#   Windows:       msedgedriver matching your WebView2 (Edge) version
#   Debian/Ubuntu: apt-get install webkit2gtk-driver
#   Fedora 43+:    dnf install webkitgtk6.0   (then: which WebKitWebDriver)
```

The wdio runner deps come in through `pnpm install`.

## Env flags

There are no enable-flags. Which tier runs is decided by the config you invoke
(`wdio.conf.ts` = T3, the multiremote configs = T4, `e2e-tests/backend` =
the probe tier), and every requirement is a **pre-flight check that fails the
run** rather than a flag that silently skips it:

| Requirement                            | Checked in                          | On failure                                    |
| -------------------------------------- | ----------------------------------- | --------------------------------------------- |
| `tauri-driver` installed               | `helpers/preflight.ts` (onPrepare)  | names the `cargo install` to run              |
| Backend stack answering (T4)           | same, before the build              | names `pnpm backend:test:up`                  |
| Binary built `--features e2e-data-dir` | same, after build / on reuse        | tells you to drop `MINDSTREAM_E2E_SKIP_BUILD` |
| Backend stack (probe tier)             | `e2e-tests/backend/global-setup.ts` | names `pnpm backend:test:up`                  |

The remaining variables are behaviour switches, not gates:

| Variable                          | Purpose                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `MINDSTREAM_E2E_BACKEND_URL`      | Override the backend URL (defaults to the disposable stack's `http://localhost:18080`).  |
| `MINDSTREAM_E2E_SKIP_BUILD=1`     | Reuse an existing binary instead of rebuilding — still verified to carry `e2e-data-dir`. |
| `MINDSTREAM_E2E_REUSE_ACCOUNTS=1` | Reuse the cached `.t4-accounts.json` instead of fresh signups.                           |
| `MINDSTREAM_E2E_EDGE_LIMITS=1`    | Opt into the rate-limit specs (they drain the shared auth bucket).                       |
| `MINDSTREAM_E2E_DIALOG_HOOK=1`    | Enable specs pending the native-dialog Rust seam.                                        |
| `MINDSTREAM_PROFILE_DIR`          | Per-test data dir (the isolation/restart seam, see below).                               |
| `MINDSTREAM_PROFILE_ID`           | Namespace the run's keyring entry.                                                       |

## Test seams

- **Data isolation & restart.** `MINDSTREAM_PROFILE_DIR` points each test at a
  temp dir; quitting and relaunching against the **same** dir is how the restart
  assertions work. This is the `dir_override` seam in
  `src-tauri/src/profiles.rs`, gated to dev builds and the `e2e-data-dir`
  feature — a shipped production binary can never be redirected by a stray env
  var.
- **Native dialogs.** File/folder pickers (export, import, PDF import) can't be
  clicked over WebDriver — they need a Rust-side hook to pre-seed the path. The
  dialog-driven specs stay skipped until that seam exists.
- **Session injection (not yet built).** T4 specs log each client in through the
  app's own `etebase_login` (drives the Account UI / IPC). Seeding a
  pre-authenticated session blob into each profile dir would skip that per run,
  but needs a Rust-side hook.
- **macOS native shell.** Native menu-bar, Dock, and window-decoration flows must
  run on a real macOS runner; Linux `xvfb` proves Tauri IPC but not App-menu
  semantics, traffic lights, or Dock reopen.

## Two-client harness (T4)

`e2e-tests/app/wdio.multiremote.conf.ts` spawns **two** tauri-driver processes,
each launching the app against its own `MINDSTREAM_PROFILE_DIR`, driven as
`browserA` / `browserB`. `wdio.multiremote.a2.conf.ts` adds a third instance for
the owner-second-device sharing cases. Details in
[e2e-tests/app/README.md](../../e2e-tests/app/README.md).

## Harness gotchas (from live T4 runs)

These are **WebDriver-layer** quirks, not app bugs — logged so they aren't
rediscovered:

- **WebKitWebDriver (Linux `wry`) rejects native input.** `element/click` and
  send-keys return `unsupported operation`. Every interaction is synthesized as
  DOM events via `browser.execute` — `harness.ts` clicks by dispatching
  `mousedown`/`mouseup`/`click` and fills by assigning `.value` + dispatching
  `input`/`change`. New helpers must go through `execute`, never `el.click()` /
  `el.setValue()`.
- **Label-wrapped inputs resolve `aria/<name>` to the `<label>`, not the field.**
  The Settings sign-in inputs wrap the control in a `<label>` with no explicit
  `aria-label`, so `setValue` drills to a descendant `input, textarea, select`
  before assigning. (Also a mild a11y smell — explicit `aria-label`/`for` would
  disambiguate for assistive tech too.)
- **Multiremote fans globals out to both clients.** The module-level `aria/`
  helpers act on every browser at once; per-client work goes through
  `clientHelpers(client)`. `loginClient` runs under `Promise.all`, so an error
  in either client surfaces as `Promise.all (index N)`.
