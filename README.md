# Mindstream Notes

[![codecov](https://codecov.io/gh/jannikgohr/mindstream-notes/branch/main/graph/badge.svg)](https://codecov.io/gh/jannikgohr/mindstream-notes)

Mindstream Notes is a local-first note-taking app built with Tauri, Svelte, Rust, and Yjs. It is designed around fast desktop note workflows, markdown editing, local persistence, optional encrypted sync, and native ink support for handwritten notes.

The project is still under active development. Expect sharp edges, but the core shape is already in place: a desktop app shell, a markdown editor, a note tree, local storage, CRDT-backed document state, and a Yjs-backed ink canvas.

## Features

- Markdown notes with a rich editor toolbar.
- Local-first persistence backed by SQLite and Yjs document state.
- Folder and note tree with trash, restore, purge, move, and sort flows.
- Optional Etebase-backed encrypted sync plumbing.
- Drawing/ink notes with pen, eraser, undo, redo, clear, color, width, page theme, pan, and zoom controls.
- Desktop layout with sidebars, metadata panel, custom window chrome, and popout support.
- Mobile-oriented Svelte UI surfaces and Android native drawing integration work in progress.

## Tech Stack

- Tauri 2 for the desktop/mobile app shell.
- Svelte 5 and SvelteKit for the interface.
- Rust for persistence, sync, and Tauri commands.
- Svelte canvas + Pointer Events for the ink editor, with an Android-only Kotlin `CanvasFrontBufferedRenderer` overlay for live-stroke latency.
- Yjs/yrs for CRDT document state.
- Vitest (unit) and Playwright (end-to-end) for the frontend, Cargo for the Rust backend; line coverage from both sides is published to Codecov.

## Repository Layout

```text
src/                    Svelte app, UI components, stores, editor code
src-tauri/              Tauri app, Rust backend, persistence, sync
backend/yjs-collab/     Experimental Yjs collaboration server pieces
e2e/                    Browser, backend, and real-app end-to-end suites
docs/                   Architecture notes and build documentation
```

## Quick Start

Install dependencies:

```shell
pnpm install
```

Run the browser development UI:

```shell
pnpm dev
```

Run the Tauri desktop app:

```shell
pnpm tauri-dev
```

Run the main checks:

```shell
pnpm check
pnpm test
```

Measure coverage. Both sides gate the **logic layer** at 80% line coverage
(frontend with the v8 provider, backend with `cargo-llvm-cov`); integration
surfaces — the Tauri IPC boundary, network sync, native dialogs, editor/canvas
frameworks — are excluded from the metric and covered by e2e instead:

```shell
pnpm test:coverage        # frontend; writes coverage/ (text + lcov), enforces 80%
pnpm test:coverage:rust   # backend; enforces 80% (needs cargo-llvm-cov)
```

Run the end-to-end suite. Playwright builds the SPA and drives it in
browser-fallback mode (the in-memory mock store backs every API call, so
no Tauri or Rust build is required):

```shell
pnpm test:e2e             # headless
pnpm test:e2e:ui          # interactive runner
```

The Playwright suite covers the pure-UI journeys today;
[docs/e2e-flows.md](docs/e2e-flows.md) defines the deeper flows (critical user
journeys, IPC-heavy operations, and cross-restart state persistence) that need
the packaged Tauri app rather than the browser fallback.

For full platform setup, packaging commands, Android notes, and Rust quality gates, see [docs/BUILDING.md](docs/BUILDING.md).

## License

Mindstream Notes is licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT License ([LICENSE-MIT](LICENSE-MIT))

at your option.
