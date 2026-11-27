# The real-app harness (T3/T4)

How `e2e-tests/app/` drives the **packaged Tauri binary** with `tauri-driver`
(WebDriver) under a headless display (`xvfb` on Linux CI). The binary is built
with `--features e2e-data-dir` so the test seams below work in a release build.
Run commands are in [e2e-tests/README.md](../../../e2e-tests/README.md); manual
Linux checks are in [Ubuntu VM QA](ubuntu-vm-qa.md).

## Toolchain

These tiers build the packaged binary, so you first need the app-build
toolchain (Rust and your OS's Tauri system dependencies) from
[docs/BUILDING.md](../../BUILDING.md). On top of that:

```sh
cargo install tauri-driver --locked   # the WebDriver bridge

# plus a platform webdriver:
#   Windows:       msedgedriver matching your WebView2 (Edge) version
#   Debian/Ubuntu: apt-get install webkit2gtk-driver
#   Fedora 43+:    dnf install webkitgtk6.0   (then: which WebKitWebDriver)
```

The wdio runner comes in through `pnpm install`.

## Requirements and env flags

The config you invoke decides the tier: `wdio.conf.ts` is T3, the multiremote
configs are T4, `e2e-tests/backend` is the probe tier. Every requirement is a
pre-flight check that fails the run rather than a flag that skips it:

| Requirement                            | Checked in                          | On failure                                    |
| -------------------------------------- | ----------------------------------- | --------------------------------------------- |
| `tauri-driver` installed               | `helpers/preflight.ts` (onPrepare)  | names the `cargo install` to run              |
| Backend stack answering (T4)           | same, before the build              | names `pnpm backend:test:up`                  |
| Binary built `--features e2e-data-dir` | same, after build / on reuse        | tells you to drop `MINDSTREAM_E2E_SKIP_BUILD` |
| Backend stack (probe tier)             | `e2e-tests/backend/global-setup.ts` | names `pnpm backend:test:up`                  |

Behaviour switches:

| Variable                              | Purpose                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `MINDSTREAM_E2E_BACKEND_URL`          | Backend URL; defaults to the test stack at `http://localhost:18080`.                                          |
| `MINDSTREAM_E2E_SKIP_BUILD=1`         | Reuse an existing binary; it is still checked for `e2e-data-dir`.                                             |
| `MINDSTREAM_E2E_PRODUCTION_PROFILE=1` | Build with the shipped release profile instead of the faster e2e one (no LTO, 16 codegen units, opt-level 2). |
| `MINDSTREAM_E2E_REUSE_ACCOUNTS=1`     | Reuse the cached `.t4-accounts.json` instead of fresh signups. Rejected with two workers.                     |
| `MINDSTREAM_E2E_MULTI_WORKERS`        | `1` or `2` spec workers for the two-client suite. Local default 1; CI uses 2.                                 |
| `MINDSTREAM_E2E_EDGE_LIMITS=1`        | Opt into the rate-limit specs; they drain the shared auth bucket.                                             |
| `MINDSTREAM_E2E_DIALOG_HOOK=1`        | Enable specs waiting on the native-dialog seam (`single/backup.e2e.ts`).                                      |
| `MINDSTREAM_E2E_SERVER_CONTAINER`     | Container the admin-command specs `docker exec` into; default `mindstream-test-server`.                       |
| `MINDSTREAM_E2E_PLUGIN_COMPONENT`     | A prebuilt conformance component for `plugin-lifecycle.e2e.ts`; without it the spec builds one.               |
| `MINDSTREAM_E2E_PLUGIN_FIXTURE`       | A folder with an already signed plugin package for the same spec.                                             |
| `MINDSTREAM_DOCKER_NO_SUDO=1`         | Run the test stack's `docker` without `sudo`.                                                                 |

The harness sets these per client; set them yourself only when running a test
build by hand:

| Variable                                  | Purpose                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `MINDSTREAM_PROFILE_DIR`                  | Per-test data directory; the isolation and restart seam.           |
| `MINDSTREAM_ROOT_DIR`                     | The app root (`<profile>/.app-root` in the harness).               |
| `MINDSTREAM_PROFILE_ID`                   | Namespaces the run's keyring entry.                                |
| `MINDSTREAM_DICTIONARY_DIR`               | Spellcheck dictionaries, which live outside the profile directory. |
| `MINDSTREAM_E2E_IMPORT_FOLDER`, `_FILE`   | Answer the notes-import folder and file pickers.                   |
| `XDG_DATA_HOME`, `XDG_CACHE_HOME` (Linux) | Isolate the WebView's storage.                                     |
| `WEBVIEW2_USER_DATA_FOLDER` (Windows)     | Same.                                                              |

## Test seams

- **Data isolation and restart.** `MINDSTREAM_PROFILE_DIR` points each client
  at a temp dir; quitting and relaunching against the same dir is how restart
  assertions work. The override (`dir_override` in `src-tauri/src/profiles.rs`)
  works only in dev builds and `e2e-data-dir` builds, so a shipped binary can't
  be redirected by a stray env var.
- **Dictionaries are not in the profile.** They live under the app-data root,
  so `MINDSTREAM_PROFILE_DIR` doesn't isolate them; `MINDSTREAM_DICTIONARY_DIR`
  does (`spellcheck::DICTIONARY_DIR_ENV`). `wdio.conf.ts` makes one per session
  and exports it to the spec, which is what `helpers/harness.ts::dictionaryDir`
  returns.
- **The WebView store can't be isolated from config.** The WebView keeps
  localStorage and its cache under `<local data dir>/<identifier>`. The
  window's `dataDirectory` key looks like the fix and isn't:
  `impl From<&WindowConfig> for WebviewAttributes` (tauri-runtime 2.11.1)
  never copies it. The harness isolates the store through the XDG and WebView2
  variables above instead.
- **Native dialogs.** WebDriver can't click native pickers. Notes import has
  the feature-gated path overrides above; backup, export and PDF pickers have
  none yet. `supervised-backup-check.py` (below) covers portable backup through
  the real Rust helpers.
- **macOS native shell.** Menu bar, Dock and window-decoration flows need a
  real macOS runner; Linux `xvfb` proves IPC but not App-menu semantics,
  traffic lights or Dock reopen.

### Still missing

- [ ] Path-injection seams for the backup, export and PDF pickers (flows 1.2–1.4,
      2.2).
- [ ] A hook to back-date `trashed_at` (flow 3.3).
- [ ] Session injection: specs sign each client in through the app's own form.
      Seeding a signed-in session into each profile would skip that, but needs a
      Rust hook.
- [ ] Presence for ink and freeform, so their restore prompt can be tested.
- [ ] Rendering of synced markdown assets in the editor (flow 4.7); the spec
      fetches the bytes through the app API.

## Adding app tests

Add a `*.e2e.ts` file in the directory for the clients it needs:

| Directory under `e2e-tests/app/specs/` | Clients    | Command                      |
| -------------------------------------- | ---------- | ---------------------------- |
| `single/`                              | One app    | `pnpm test:e2e:app`          |
| `multi/`                               | Two apps   | `pnpm test:e2e:app:multi`    |
| `multi-a2/`                            | Three apps | `pnpm test:e2e:app:multi:a2` |

Nested directories work. No spec list, CI filter, port or worker assignment
needs editing. `pnpm lint:ci` checks that every app spec is discovered exactly
once, so a file outside these directories fails the check instead of silently
missing CI. Keep shared state within a spec; separate files must be safe to run
in parallel.

`wdio.multiremote.conf.ts` starts two tauri-driver processes, each launching
the app against its own profile, driven as `browserA` / `browserB`.
`wdio.multiremote.a2.conf.ts` adds a third for the owner-second-device cases.
With two workers on one runner, each worker gets its own four driver ports,
keyring ids, profiles, dictionaries and WebView storage, and its own accounts.
The three-client suite stays serial because its tests share one spec's setup.
Measure a full Linux run before going past two workers. When to run each suite
in CI is in [strategy.md](strategy.md#in-ci).

## Gotchas

These are WebDriver-layer quirks or traps, not app bugs:

- **WebKitWebDriver (Linux) rejects native input.** `element/click` and
  send-keys return `unsupported operation`. `harness.ts` synthesises DOM events
  through `browser.execute`. New helpers must go through `execute`, never
  `el.click()` / `el.setValue()`.
- **Label-wrapped inputs resolve `aria/<name>` to the `<label>`.** `setValue`
  drills to a descendant `input, textarea, select` before assigning.
- **Multiremote fans globals out to every client.** The module-level `aria/`
  helpers act on all browsers at once; per-client work goes through
  `clientHelpers(client)`. `loginClient` runs under `Promise.all`, so an error
  surfaces as `Promise.all (index N)`.
- **A cascading first failure hides its cause.** A modal left open by one
  failed assertion makes later tests time out somewhere else. Run the first
  failing test alone with `--mochaOpts.grep`.
- **The server container must match the client.** `pnpm backend:test:up`
  rebuilds the server when its source changed, but a stack left running from
  another commit can disagree with the app about the room protocol and look
  like an app bug. `curl http://localhost:18080/api/v1/mindstream/info/` shows
  what the running server speaks.

## Running a test build by hand

Debug and `e2e-data-dir` builds accept `MINDSTREAM_ROOT_DIR` and
`MINDSTREAM_PROFILE_DIR`. Test builds without either refuse to start. Windows
also needs an absolute `WEBVIEW2_USER_DATA_FOLDER`; Linux needs absolute,
isolated `XDG_DATA_HOME` and `XDG_CACHE_HOME`. Without an explicit root, a
profile override uses `<profile>/.app-root`.

For an embedded native debug fixture, build the production frontend first and
use Tauri's production protocol feature. Clearing `devUrl` alone leaves
`tauri::is_dev()` on, which disables automatic coordinator revival:

```powershell
pnpm build
$env:TAURI_CONFIG = '{"build":{"devUrl":null}}'
cd src-tauri
cargo build --features tauri/custom-protocol
```

## Concurrent vault checks

Python fixtures in `src-tauri/scripts/` run several vaults on one disposable
root with real OS leases. They quit through the authenticated Quit command and
wait for leases to be released; an owner they can't account for is left for
inspection, never killed by PID. Build the embedded debug binary first, and on
Windows wait for the build to finish, since a running app blocks replacing the
executable.

```powershell
python src-tauri/scripts/supervised-handoff-check.py --output .output/handoff-check
python src-tauri/scripts/supervised-handoff-ui-check.py --exe src-tauri/target/debug/mindstream-notes.exe --output .output/handoff-editor-check --check-progress
python src-tauri/scripts/supervised-shortcuts-check.py --output .output/shortcut-check --check-update-recovery
python src-tauri/scripts/supervised-startup-check.py --output .output/startup-check --check-ui
python src-tauri/scripts/supervised-theme-check.py --output .output/theme-check
python src-tauri/scripts/supervised-backup-check.py --output .output/backup-check --test-exe <mindstream_notes_lib test executable>
python src-tauri/scripts/supervised-dev-check.py --dev-url http://127.0.0.1:1421 --output .output/dev-vault-check
```

- **Handoff:** moving a vault between windows, including missing and existing
  targets, save failure, a busy job, a coordinator crash and a replaced
  target. Close errors shown by the failure cases are expected.
- **Handoff UI** (Windows, `msedgedriver` on PATH): unsaved main and popout
  editors with automatic saving off; `--check-progress` checks the progress
  toast. It follows
  [Microsoft's WebView2 attachment workflow](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/webdriver).
- **Shortcuts:** global shortcuts, autostart and update recovery.
- **Startup:** an unreadable vault index, retry, and adopting a surviving
  worker; `--check-ui` (Windows) drives the vault picker.
- **Theme** (Windows): appearance migrated to the root, live changes across
  vaults and popouts, presets and the missing-preset fallback. Each vault has
  its own WebView2 debugging port; one fixed port can't reach them all.
- **Backup:** restore startup, approval gates, a separate vault, cold restart
  and lease release; on Windows `--check-ui` renders the restore-choice
  dialog.
- **Dev:** run against a Vite server; with close to tray on the coordinator
  outlives its last worker, with it off closing the last worker ends the CLI
  session.

The busy-job case holds its job for 60 seconds, past the source's 30-second
drain timeout even on a slow runner. Focus is recorded in
`focus-observed.json`; Windows may refuse focus, so it is only required with
`--check-focus` on an isolated desktop.

Linux runs these in a container: `linux-vault-check.Dockerfile` and
`linux-vault-check.sh` with the source mounted read-only at `/source` and an
empty `/results`, under D-Bus, Xvfb and Openbox. `linux-wayland-check.sh` runs
the same binary under nested Weston with GTK forced to Wayland; Xvfb gives the
compositor an input seat. The container turns WebKit's nested sandbox off for
this disposable root only. Shell scripts keep LF endings through
`.gitattributes`.

Not covered by any fixture, and left to release QA: reboot durability, real
desktop keyboard and tray use, monitor and DPI changes, signed updater
installation on Windows and macOS, and the packaged macOS app.
