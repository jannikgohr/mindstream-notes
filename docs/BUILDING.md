# Building Mindstream Notes

This document collects setup, build, and verification notes that are too detailed for the main README.

## Prerequisites

Every platform needs:

- **Node.js 20+** and **pnpm** (`corepack enable`, or `npm i -g pnpm`).
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
[e2e/harness.md](e2e/harness.md#toolchain) for the toolchain.

## Development

Install JavaScript dependencies:

```shell
pnpm install
```

Start the browser development UI:

```shell
pnpm dev
```

Start the Tauri desktop app:

```shell
pnpm tauri-dev
```

The Tauri config runs `pnpm setup-android-cargo` before dev and build commands so Android cargo configuration stays in sync.

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

If Android cargo setup needs to be refreshed manually:

```shell
pnpm setup-android-cargo
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
