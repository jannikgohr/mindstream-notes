# Building Mindstream Notes

The setup and build steps that are too detailed for the main README. Commit
conventions, hooks and tests are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Prerequisites

Every platform needs:

- **Node.js 22.11+** and **pnpm** (`corepack enable`, or `npm i -g pnpm`). CI
  runs Node 22. On Node 20 the plugin SDK tests in `pnpm test` fail, because
  its WebAssembly engine cannot compile the SDK's components.
- **Rust**, stable toolchain, via [rustup](https://rustup.rs).
- The **Tauri 2 system dependencies** for your OS — see the per-OS setup below.
- For the browser app (`pnpm dev`), the **Wasm toolchain**: the
  `wasm32-unknown-unknown` target, `wasm-bindgen-cli` 0.2.126, and Clang with
  `lld`. [Run the browser app](internal/browser-support.md#run-the-browser-app)
  has the commands. `pnpm tauri-dev` does not need it.
- **Java 17** or later, only for Android builds. CI uses 17.

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

Start the browser app. This builds the Wasm storage worker first, then starts
Vite:

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

`pnpm tauri-dev` runs as a separate `.dev` app with its own data folder and
credentials, so it can run next to an installed release. It does not register
global shortcuts or install the autostart and updater plugins. Start it through
this script rather than enabling the `dev-environment` feature by hand. Never
point a binary older than vault locking at a vault a newer one uses.

How the desktop app runs its vaults in development, and how to launch an
isolated test build by hand, is in the
[architecture notes](internal/architecture.md#desktop-vault-runtime) and the
[real-app harness](internal/e2e/harness.md#running-a-test-build-by-hand).

## Desktop builds

Build a production frontend bundle:

```shell
pnpm build
```

Build the desktop Tauri app:

```shell
pnpm tauri-build
```

The macOS app needs macOS 14 or later.

Linux AppImage builds may need:

```shell
NO_STRIP=true ARCH=x86_64 pnpm tauri build
```

## Android builds

With Java 17 or later, run:

```shell
pnpm tauri android build
```
