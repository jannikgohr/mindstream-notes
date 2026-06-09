# Building Mindstream Notes

This document collects setup, build, and verification notes that are too detailed for the main README.

## Prerequisites

- Node.js and pnpm.
- Rust with the stable toolchain.
- The Tauri 2 platform prerequisites for your operating system.
- Java 21 for Android builds.

On minimal Linux systems, install and enable a Secret Service provider such as `gnome-keyring`, or run KeePassXC with Secret Service enabled. Some crypto dependencies may also require OpenSSL development libraries or the Perl build tooling used by OpenSSL builds.

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
