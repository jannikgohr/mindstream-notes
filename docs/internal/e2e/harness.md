# The real-app harness (T3/T4)

Current Linux VM, real-picker, signed-package and hard-reset procedures are in
[Ubuntu VM QA](ubuntu-vm-qa.md). Dated evidence below describes earlier runs.

How the `e2e-tests/app/` suite drives the **packaged Tauri binary** with
`tauri-driver` (WebDriver) under a headless display (`xvfb` on Linux CI). The
binary is built with `--features e2e-data-dir` so the test seams below work in a
release build. Run commands are in [e2e-tests/README.md](../../../e2e-tests/README.md);
two-client specifics are in [e2e-tests/app/README.md](../../../e2e-tests/app/README.md).

## Toolchain

These tiers build and drive the packaged binary, so you first need the base
app-build toolchain (Rust + your OS's Tauri system deps) from
[docs/BUILDING.md](../../BUILDING.md). On top of that:

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
| `MINDSTREAM_E2E_IMPORT_FOLDER`    | Pre-seed the notes-import folder picker in `e2e-data-dir` builds.                        |
| `MINDSTREAM_E2E_IMPORT_FILE`      | Pre-seed the notes-import file picker in `e2e-data-dir` builds.                          |
| `MINDSTREAM_PROFILE_DIR`          | Per-test data dir (the isolation/restart seam, see below).                               |
| `MINDSTREAM_PROFILE_ID`           | Namespace the run's keyring entry.                                                       |

## Test seams

- **Data isolation & restart.** `MINDSTREAM_PROFILE_DIR` points each test at a
  temp dir; quitting and relaunching against the **same** dir is how the restart
  assertions work. This is the `dir_override` seam in
  `src-tauri/src/profiles.rs`, gated to dev builds and the `e2e-data-dir`
  feature — a shipped production binary can never be redirected by a stray env
  var.
- **WebView store — not isolated, and not isolable from config.** The WebView
  keeps localStorage and its cache outside the profile dir, under
  `<local data dir>/<identifier>`, shared by every client of a run. The
  window's `dataDirectory` config key looks like the fix and is not:
  `impl From<&WindowConfig> for WebviewAttributes` (tauri-runtime 2.11.1)
  never copies it, so Tauri drops the value for any window it creates from
  config and falls back to the shared path. The multi-client suites used to
  compile one binary per client to vary that key; the builds were collapsed to
  one once this was confirmed by launching the binary directly and watching the
  directory never appear.
- **Native dialogs.** WebDriver can't click native pickers. Notes import has
  feature-gated folder/file path overrides; backup, export and PDF flows still
  need equivalent seams for picker interaction. Portable backup export/preview/
  staging is exercised through the real Rust helpers; the
  `supervised-backup-check.py` fixture then verifies desktop restore startup,
  approval gates, a separate vault, cold restart and lease release. See the
  [backup contract](../backup-restore-portability.md#verification).
  On Windows, `--check-ui` renders the real restore-choice dialog using a
  fixture preview through the bundled dialog helper, so its unchecked default
  and returned selection are checked without a second replacement or a picker.
- **Session injection (not yet built).** T4 specs log each client in through the
  app's own `etebase_login` (drives the Account UI / IPC). Seeding a
  pre-authenticated session blob into each profile dir would skip that per run,
  but needs a Rust-side hook.
- **macOS native shell.** Native menu-bar, Dock, and window-decoration flows must
  run on a real macOS runner; Linux `xvfb` proves Tauri IPC but not App-menu
  semantics, traffic lights, or Dock reopen.

## Two-client harness (T4)

### Adding app E2E tests

Add a `*.e2e.ts` file in the directory for the clients it needs:

| Directory under `e2e-tests/app/specs/` | Clients    | Command                      |
| -------------------------------------- | ---------- | ---------------------------- |
| `single/`                              | One app    | `pnpm test:e2e:app`          |
| `multi/`                               | Two apps   | `pnpm test:e2e:app:multi`    |
| `multi-a2/`                            | Three apps | `pnpm test:e2e:app:multi:a2` |

Nested directories work too. No spec list, CI filter, port allocation or
worker assignment needs editing. `pnpm lint:ci` checks that every app spec is
discovered exactly once, so a file placed outside these directories fails the
check instead of silently missing CI. Use the existing account helpers for
fresh users and the client helpers for browser interactions. Keep shared
state within a spec; separate files must be safe to run in parallel.

### CI scheduling

CI skips both Playwright and packaged-app E2E on draft PRs. Marking a PR ready
enables E2E for code changes. Adding `ci:app-e2e` or starting a manual workflow
run forces every suite, including on drafts and docs-only changes. Other labels
do not rerun the test jobs or cancel a code run. Unit tests, coverage, lint and
type checks still run on draft code changes.

The two-client suite runs two spec workers on one CI runner, sharing one
backend. Each worker gets four distinct driver ports, separate keyring IDs,
temporary profiles and dictionaries, and isolated WebView storage. Accounts
are unique per spec; reusing cached accounts is rejected with parallel workers.
Local runs default to one worker. Set `MINDSTREAM_E2E_MULTI_WORKERS=2` to try
parallel runs, or set it to `1` in CI to reduce memory and CPU pressure.
The three-client suite stays serial because its tests share one spec's setup.
Measure a full Linux run before increasing concurrency beyond two workers.

`e2e-tests/app/wdio.multiremote.conf.ts` spawns **two** tauri-driver processes,
each launching the app against its own `MINDSTREAM_PROFILE_DIR`, driven as
`browserA` / `browserB`. `wdio.multiremote.a2.conf.ts` adds a third instance for
the owner-second-device sharing cases. Details in
[e2e-tests/app/README.md](../../../e2e-tests/app/README.md).

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

## Concurrent vault checks

Shared-root vault fixtures complement the existing isolated-device multiremote
suites. They use disposable roots and real OS leases. Cleanup uses authenticated
Quit and waits for released coordinator/vault leases; it retains uncertain
owners for inspection rather than killing a PID discovered on disk.

Build an embedded debug binary as described in [BUILDING.md](../../BUILDING.md).
Wait for the build to finish before launching it on Windows, where live app
processes prevent executable replacement.

```powershell
python src-tauri/scripts/supervised-handoff-check.py --output .output/handoff-check
python src-tauri/scripts/supervised-handoff-ui-check.py --exe src-tauri/target/debug/mindstream-notes.exe --output .output/handoff-editor-check --check-progress
python src-tauri/scripts/supervised-shortcuts-check.py --output .output/shortcut-check --check-update-recovery
python src-tauri/scripts/supervised-startup-check.py --output .output/startup-check --check-ui
python src-tauri/scripts/supervised-theme-check.py --output .output/theme-check
```

The handoff fixture covers ordinary transfer, existing targets, missing targets,
save failure, busy-job timeout, source retained after coordinator crash, source
already closed, changed source identity, target replacement and missing startup.
The WebView2 UI fixture needs `msedgedriver` on PATH and verifies main/popout
persistence with automatic saving disabled. `--check-progress` also exercises the
source window API and checks the persistent toast wording, placement and absent
close button. It attaches only to its own isolated
browser. This follows [Microsoft's WebView2 attachment workflow](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/webdriver).
Failure fixtures intentionally display close errors while preserving the source;
those toasts are expected evidence of safe cancellation.

The startup fixture makes the vault index temporarily unreadable in its own
root, verifies a terminal failure and retries initialization. It also crashes
its own coordinator, sets the last-used entry to a missing directory and checks
that the exact surviving worker is adopted. `--check-ui` requires Windows and
`msedgedriver`. It verifies German/light root preferences, native picker controls,
disabled missing-vault selection, and real select/create actions. No vault is
chosen as a migration source until the user selects or creates one. Original index bytes and
failure artifacts remain in the fixture directory.

The Windows theme fixture seeds different legacy appearance/editor settings in
two vaults. It checks root migration, live accent/font/mode changes across both
vaults and a source popout, real preset selection/import, missing-preset fallback
with retained selection, and cold restart. It verifies the original vault fields
remain intact. Each vault gets its own automatic WebView2 debugging port; the
fixture attaches separate WebDriver sessions to their `DevToolsActivePort` files.
Those paths derive from the fixture's authenticated registrations and browser
identity hash. One fixed debugging port cannot inspect separate vault browsers.
Only the owned driver process stops directly; app cleanup uses authenticated Quit.

Theme evidence from 2026-10-13 is retained in `.output/themes-final-native-check`.
It includes the custom-preset settings screenshot and restarted computed styles.
The final theme run passes all 145 affected frontend tests and Rust fmt/clippy/full
tests. Windows passes 893 unit tests and one integration test, five ignored overall;
Linux passes 895 unit tests and one integration test, two ignored overall.
Windows repeats all ten handoff cases and all four startup cases in
`.output/themes-handoff-regression` and `.output/themes-startup-regression`.
Linux X11 repeats all ten handoff and both startup cases in
`.output/linux-vault-check/native-20261012-230544` and
`.output/linux-vault-check/startup-20261012-230824`.
Nested Wayland repeats those cases, including focus, in
`.output/linux-wayland-check/native-20261012-230623` and
`.output/linux-wayland-check/startup-20261012-230908`.
Native theme UI validation covers Windows; packaged macOS and the existing
reboot/monitor/DPI/signed-updater release checks retain their prior status.

For development lifetime, start a Vite server and run:

```powershell
python src-tauri/scripts/supervised-dev-check.py --dev-url http://127.0.0.1:1421 --output .output/dev-vault-check
```

This starts the real project Tauri CLI against a disposable root and checks
handoff. With close-to-tray on, the coordinator must outlive its last worker and
open another; with it off, closing the last worker must end the CLI session.
It leaves the existing Vite server running.

Linux uses `linux-vault-check.Dockerfile` and `linux-vault-check.sh` with source
mounted read-only at `/source` and an empty writable results directory at
`/results`. The script copies source to `/work`, runs Rust quality gates, builds
with `tauri/custom-protocol`, then runs native checks under D-Bus/Xvfb/Openbox.
Both Linux runners include the startup discovery/retry and surviving-worker checks.
`linux-wayland-check.sh` runs the checked binary under nested Weston, with GTK
forced to its Wayland backend. Xvfb provides the compositor an input seat; an
initial headless-backend run had no usable keyboard focus. Source shell scripts
keep LF line endings through `.gitattributes`.
The container disables WebKit's nested sandbox only for this disposable root-run
fixture; this setting is not an application launch policy.

Local evidence from 2026-10-12:

| Check                                  | Result and retained evidence                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows native handoff/recovery        | All ten cases pass; `.output/handoff-release-lifecycle-check`.                                                                                  |
| Native progress toast                  | Pass through the source window API; correct wording, bottom/right placement, no dialog or close button; `.output/handoff-progress-toast-check`. |
| Unsaved main and popout editors        | Pass with automatic saving disabled; `.output/handoff-release-editor-check`.                                                                    |
| Development launcher lifetime          | Pass across handoff, last-worker closure and reopening; `.output/handoff-release-dev-check`.                                                    |
| Shortcut/autostart/update regression   | Pass, including all-vault/popout/hidden-state restart and normal cold startup; `.output/handoff-verified-shortcuts-check`.                      |
| Linux X11 lifecycle/recovery           | All ten cases pass; `.output/linux-vault-check/native-20261012-174653`.                                                                         |
| Linux Wayland lifecycle/recovery/focus | All ten cases pass with an isolated input seat; `.output/linux-wayland-check/native-20261012-175438`.                                           |

Windows checks ran on Windows 11 Pro build 26300. The Linux build uses Rust 1.97.1, Tauri 2.11.1, GTK 3.24.38, WebKitGTK 2.50.6,
Openbox and Weston 10 in Debian Bookworm containers. Rust fmt/clippy/full serial tests pass on both platforms. Windows passes 887
unit tests and one integration test, with five ignored overall. Linux passes 889
unit tests and one integration test, with two ignored overall. Svelte checks, affected ESLint,
localization and production frontend/native builds pass. All fixture vaults
closed gracefully and released their OS leases.

The startup hardening run on the same date passed all four Windows startup cases
in `.output/startup-hardening-final-check`, including actual picker selection and
creation. It retains the German/light picker screenshot and state. The repeated
Windows handoff and unsaved-editor checks use `.output/startup-hardening-handoff-check`
and `.output/startup-hardening-editor-check`.
The repeated Linux X11 run passed all ten handoff cases and both startup cases in
`.output/linux-vault-check/native-20261012-191456` and
`.output/linux-vault-check/startup-20261012-191736`.
The final Wayland run passed all ten handoff cases and both startup cases in
`.output/linux-wayland-check/native-20261012-191207` and
`.output/linux-wayland-check/startup-20261012-191435`.
All 61 affected vault/settings/API frontend tests pass, along with Svelte, affected
ESLint, production frontend/native builds and formatting checks.

The busy-job fixture holds its job for 60 seconds, leaving time for target
preparation before the source's 30-second drain timeout. A prior 35-second hold
could expire within that timeout on a busy runner and correctly allow closure.

Native foreground focus is recorded in `focus-observed.json`. On an ordinary
Windows desktop the OS may refuse focus or another app may take it; lifecycle
checks therefore record focus rather than requiring it. `--check-focus` makes
focus mandatory for an isolated desktop. The Linux runners use it. These
container checks verify the recorded X11/Wayland sessions, not every compositor.
Wayland controls global window position; the fixture checks saved size and
compositor-provided coordinates. Packaged macOS retains its accepted unverified
release check. Reboot durability, real desktop keyboard/tray interactions,
monitor/DPI transitions and signed updater installation remain release QA.
