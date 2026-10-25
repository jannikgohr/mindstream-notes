# Mindstream Notes

[![codecov](https://codecov.io/gh/jannikgohr/mindstream-notes/branch/main/graph/badge.svg)](https://codecov.io/gh/jannikgohr/mindstream-notes)

Mindstream Notes is a local-first note-taking app built with Tauri, Svelte, Rust
and Yjs. Your notes live in a database on your device, and the app works
without an account. Sync is optional and end-to-end encrypted, and the server it
talks to is in this repository for you to host yourself.

The desktop app runs on Windows, Linux and macOS. Android is a work in progress.
The project is under active development, so expect sharp edges.

## Features

- Markdown notes with WYSIWYG, source and split views, `[[wikilinks]]` and
  `@mentions`
- Handwritten notes, drawing canvases, PDFs you can write on, and kanban boards
- Typst documents with a live preview, through a bundled plugin
- Spell checking with the app's own dictionaries, and grammar checking through a
  LanguageTool server
- Note history, trash, and several vaults side by side
- Import from Markdown folders, Obsidian, Joplin and Evernote, export for every
  note type, and vault backups
- Encrypted sync, shared folders and live co-editing through your own server
- Plugins as sandboxed WebAssembly components, written in Rust or TypeScript
- English and German interface

## Install

Download the app from the
[releases page](https://github.com/jannikgohr/mindstream-notes/releases). To
run your own sync server, follow the
[self-hosting quick start](docs/self-hosting.md).

## Development

```shell
pnpm install      # also installs the git hooks
pnpm dev          # the UI in a browser, on an in-memory mock store
pnpm tauri-dev    # the desktop app
```

- [docs/BUILDING.md](docs/BUILDING.md): per-OS prerequisites, release builds,
  Android
- [CONTRIBUTING.md](CONTRIBUTING.md): commit conventions (the scope is
  required), git hooks, tests and coverage
- [e2e-tests/README.md](e2e-tests/README.md): the end-to-end suites
- [docs/architecture.md](docs/architecture.md): how the app fits together

The [documentation index](docs/README.md) lists everything else.

## License

The app is licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT License ([LICENSE-MIT](LICENSE-MIT))

at your option. That covers everything in this repository except the parts in
this table, which have a licence of their own:

| Path                                                              | What it is                                    | Licence                                          |
| ----------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------ |
| [`backend/server/`](backend/server)                               | The sync server                               | AGPL-3.0-only ([text](backend/server/LICENSE))   |
| [`vendor/etebase-rs/`](vendor/etebase-rs)                         | The Etebase client library, changed here      | BSD-3-Clause ([text](vendor/etebase-rs/LICENSE)) |
| [`packages/svelte-kanban/`](packages/svelte-kanban)               | A fork of `@svar-ui/svelte-kanban`, the board | MIT ([text](packages/svelte-kanban/LICENSE))     |
| `src-tauri/gen/android/gradlew`, `gradlew.bat`, `gradle/wrapper/` | The Gradle wrapper                            | Apache-2.0                                       |
| `plugins/*/icons/`                                                | Plugin icons from Lucide and Simple Icons     | ISC, CC0-1.0                                     |

The server is a program of its own. The app does not contain it and talks to it
over the network. The files in [`protocol/`](protocol), which both are tested
against, are under the app's licence.

[REUSE.toml](REUSE.toml) says the same for every file, in a form tools can read.
The licence texts are in [LICENSES/](LICENSES), and CI runs `reuse lint`.
