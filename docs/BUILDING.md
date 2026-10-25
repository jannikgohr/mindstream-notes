# Building Mindstream Notes

This document collects setup, build, and verification notes that are too detailed for the main README.

## Prerequisites

Every platform needs:

- **Node.js 22.11+** and **pnpm** (`corepack enable`, or `npm i -g pnpm`). CI
  runs Node 22. On Node 20 the plugin SDK tests in `pnpm test` fail, because
  its WebAssembly engine cannot compile the SDK's components.
- **Rust**, stable toolchain, via [rustup](https://rustup.rs).
- The **Tauri 2 system dependencies** for your OS — see the per-OS setup below.
- **Java 21** — only for Android builds.

Then install the JS dependencies once with `pnpm install`.

### Windows

- **Microsoft C++ Build Tools** — install the "Desktop development with C++"
  workload (the standalone Build Tools installer is enough; full Visual Studio
  is not required). This provides the MSVC linker Rust needs.
- **WebView2 runtime** — preinstalled on Windows 11 and current Windows 10;
  otherwise install the Evergreen bootstrapper from Microsoft.
- **Rust** via `rustup` (defaults to the `x86_64-pc-windows-msvc` toolchain,
  which is what you want).

No extra system packages are needed beyond those.

### Ubuntu / Debian

```sh
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libsoup-3.0-dev \
  libgtk-3-dev \
  librsvg2-dev \
  libayatana-appindicator3-dev \
  libssl-dev \
  build-essential curl wget file
```

This is the same list CI installs. On minimal/headless installs also add a
Secret Service provider so the OS keyring works:
`sudo apt-get install gnome-keyring` (or run KeePassXC with Secret Service
enabled).

### Fedora

```sh
sudo dnf install \
  webkit2gtk4.1-devel \
  libsoup3-devel \
  gtk3-devel \
  librsvg2-devel \
  libappindicator-gtk3-devel \
  openssl-devel \
  curl wget file
sudo dnf group install "c-development"
```

Add a Secret Service provider (`sudo dnf install gnome-keyring`, or KeePassXC)
on minimal installs so the OS keyring works.

### Running the tests

`pnpm test` and the browser e2e suite (`pnpm test:e2e`) need nothing beyond the
above. The **real-app e2e tiers (T3/T4)** need extra tooling — `tauri-driver`
plus a platform webdriver, and for T4 a Docker backend stack. See
[e2e-tests/README.md](../e2e-tests/README.md) for how to run them and
[internal/e2e/harness.md](internal/e2e/harness.md#toolchain) for the toolchain.

## Development

Install JavaScript dependencies:

```shell
pnpm install
```

Start the browser development UI:

```shell
pnpm dev
```

Two query parameters change what the browser UI shows. They work on the dev
server only, and the desktop app ignores them:

- `?windowControls` draws the desktop app's minimize, maximize and close
  buttons. They do nothing in a browser. Use it for screenshots.
- `?mobile=1` shows the Android layout, `?mobile=ios` the iOS one.

Start the Tauri desktop app:

```shell
pnpm tauri-dev
```

The desktop development wrapper adds `tauri.dev.conf.json` and the
`dev-environment` feature. Dev uses the `.dev` bundle identity and a persistent
separate data root, WebView store and credential namespace. It can run alongside
a release build. Dev/test builds do not register global shortcuts or install
autostart/updater plugins. Use the wrapper rather than enabling the dev feature
with the production config. Optimization level alone does not choose identity.
Release builds keep the historical root and credential entries. Accounts remain
vault-specific within each environment. Never run an older binary that lacks
vault locking against the same physical vault as a new binary.

Normal desktop launches run a persistent coordinator and isolated vault workers.
The coordinator survives vault handoffs in `tauri dev`. As in a release, closing
the last vault window ends it, and with it the development session, unless
close-to-tray is on. Test devices remain direct by default. Use
`--supervised-vaults` when testing several vaults in one root.

For an embedded native debug fixture, build the production frontend first and
use Tauri's production protocol feature. Clearing `devUrl` alone still leaves
`tauri::is_dev()` enabled and deliberately disables automatic coordinator revival:

```powershell
pnpm build
$env:TAURI_CONFIG = '{"build":{"devUrl":null}}'
cd src-tauri
cargo build --features tauri/custom-protocol
```

Debug and `e2e-data-dir` builds accept `MINDSTREAM_ROOT_DIR` and
`MINDSTREAM_PROFILE_DIR`. The real-app harness sets both and isolates browser
storage before launching. Manual Windows test launches also require an absolute
`WEBVIEW2_USER_DATA_FOLDER`; Linux tests require absolute isolated
`XDG_DATA_HOME` and `XDG_CACHE_HOME`. A backend path override alone is insufficient.
Without an explicit root, a profile override uses `<profile>/.app-root` for
legacy harness compatibility. Test builds without any override refuse startup.

Desktop macOS builds now require macOS 14. The owner accepted deferring packaged
Dock/menu/Reopen testing until a release can be tested on a Mac.

## Desktop Builds

Build a production frontend bundle:

```shell
pnpm build
```

Build the desktop Tauri app:

```shell
pnpm tauri-build
```

Linux AppImage builds may need:

```shell
NO_STRIP=true ARCH=x86_64 pnpm tauri build
```

## Android Builds

Use Java 21, then run:

```shell
pnpm tauri android build
```

## Verification

Frontend type and Svelte diagnostics:

```shell
pnpm check
```

Frontend tests:

```shell
pnpm test
```

Root-level verification:

```shell
pnpm verify
```

Tauri Rust tests:

```shell
cd src-tauri
cargo test
```

Tauri Rust clippy:

```shell
cd src-tauri
cargo clippy -- -D warnings
```

## Useful Scripts

```text
pnpm dev              Start Vite
pnpm build            Build SvelteKit
pnpm check            Sync SvelteKit, run svelte-check
pnpm test             Run Vitest
pnpm tauri-dev        Start the Tauri desktop app
pnpm tauri-build      Build the Tauri desktop app
```
