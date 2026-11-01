# Browser support

The browser app stores local notes in OPFS SQLite through a dedicated Wasm
worker. Hard reloads and closing the owning tab retain committed notes,
folders, attachments, history, and editor CRDT state. Authentication, encrypted
sync, offline app loading, and a browser release are pending.

The earlier `/sqlite-proof/` page remains a separate compatibility check. It
uses a different database and lock from the app.

## Run the browser app

Install Rust's Wasm target, Clang with a WebAssembly backend, LLVM's archiver,
and the binding generator pinned by `src-tauri/browser-wasm/Cargo.toml`.
On Ubuntu, `sudo apt-get install clang lld` supplies the C tools.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126 --locked
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:1420/`, create and edit a note, wait for the saved
indicator, then hard reload. `pnpm dev` builds the worker Wasm before starting
Vite. `pnpm build:browser` builds both Wasm and the static frontend. Tauri uses
`pnpm dev:native` and keeps its existing native toolchain requirements.

The app permits one owning tab per browser profile and origin. A second tab
reports that the database is already open. Close the owner and reload the
second tab to take ownership. Closing a tab before the editor acknowledges a
save can still discard an edit that has not reached storage.

At `/sqlite-proof/`, save a marker and reload to exercise the separate proof
database. Its close button releases ownership without closing the tab.

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml -p mindstream-storage-core
pnpm exec vitest run src/lib/browser/client.test.ts
pnpm exec playwright install chromium firefox webkit
pnpm test:sqlite
```

The generated files live in `static/browser-wasm/` and are ignored by Git.
`pnpm build:wasm` uses the workspace lockfile. `pnpm build` copies those files
into the static app output when they exist. A regular native build does not
need the Wasm toolchain.

## Storage choices

The proof pins `rusqlite` 0.39.0, `sqlite-wasm-rs` 0.5.5, and
`sqlite-wasm-vfs` 0.2.0. Rusqlite 0.39 uses SQLite Wasm's 0.5 ABI. The VFS
release uses the matching `rsqlite-vfs` 0.1 ABI. The lockfile pins the full
graph, including `wasm-bindgen` 0.2.126. Changing just one of these versions
requires rebuilding and repeating the browser checks.

A dedicated worker owns one connection and one OPFS sync-access-handle pool.
It uses rollback journals and `synchronous=FULL`. Native connections keep
using WAL. An exclusive Web Lock covers the whole pool because installing
the pool acquires its file handles. A second tab receives `databaseBusy`
before it installs the VFS. It can retry after the owner closes. Closing or
terminating the worker releases ownership. Requests run in sequence, and the
client rejects pending requests if the worker fails or times out.

This follows the upstream [VFS constraints](https://docs.rs/crate/sqlite-wasm-rs/0.5.1)
and [OPFS access-handle pool design](https://sqlite.org/wasm/doc/trunk/persistence.md#vfs-opfs-sahpool).
The pool needs a secure context and a dedicated worker. It does not require
COOP/COEP headers. There is no in-memory fallback after an OPFS failure.

The app uses `.mindstream-browser-vault/notes.sqlite3` in the origin's private
filesystem. The proof uses `.mindstream-sqlite-proof/proof.sqlite3`. Neither can
open a native vault. Fresh app databases receive the shared seed once. Emptying
an existing vault does not seed it again.
Browser storage belongs to the origin, so changing hostname, scheme, or port
selects different storage. Clearing site data deletes it. Browser eviction
policy and private browsing behavior still need product-level handling.

## What the checks cover

The native and Wasm builds call the same migration runner and behavior check.
The browser tests exercise the compiled Rust and OPFS, with no mocked SQLite.
They verify fresh migration through schema 34, upgrades of eleven populated
historical schemas, migration idempotence, FTS5 trigram queries and update
triggers, rollback, committed writes, foreign-key enforcement, and deterministic
CRDT seed merging. Upgrade checks retain note content and asset hashes.

Playwright checks reload persistence, explicit close and reopen, second-tab
refusal, ownership transfer, and owner-tab termination. The transport unit
tests cover response correlation, structured errors, validation, worker
failure, timeout, and shutdown failure. Real-app tests create and edit a note
through the existing Svelte editor, reload with the HTTP cache disabled, close
the tab, and reopen the note. They also verify folders, tags, favourites,
attachment bytes, history, Yjs state, trash and restore, and owner-tab handoff.

The production tests pass in Chromium and Firefox. The WebKit project uses a
separate persistent profile per test because its temporary contexts disable
OPFS. The Playwright 1.61.1 Linux WebKit build also exposes no OPFS API in a
persistent profile, including over HTTPS. The suite explicitly skips WebKit
storage tests only when it reports `unsupported` and its OPFS API is absent.
WebKit storage remains unverified. See the
[Playwright storage documentation](https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state).
Safari on real devices, mobile browsers, storage exhaustion, and
interrupted-write recovery need further validation before browser support
ships.

## Shared code

`src-tauri/storage-core` has no Tauri dependency. It owns the canonical
migrations, note and folder mutations, attachment bookkeeping, history, local
share permissions and scope changes, trash operations, signatures, PDF text,
word counts, setup notes, search, and note and tag CRDT operations. Native
modules forward to it and preserve their existing command signatures and
structured error codes. Migration SQL and CRDT encodings stay the same.

`src-tauri/browser-wasm` installs the browser VFS and exposes shared operations.
Rust deserializes each request into `VaultRequest` before it can execute.
`src/lib/browser` holds the typed command map, dedicated worker, and asynchronous
client. `invokeOrFallback` routes supported browser operations to this client
and applies the existing response validators. Browser file-byte helpers and
setup note inserts use the same store. Saves resolve after the shared mutation
commits. Storage failures propagate to the UI, with no fallback to memory.

The in-memory store remains available to unit tests and to the existing UI
fixture suite with `VITE_BROWSER_MOCKS=1`. That flag is for disposable test
builds. Normal browser development and browser builds use persistent storage.
Browser application events use an in-process event bus; native commands and
event delivery keep using Tauri.

## Remaining increments

1. Complete platform services for native file integrations, browser downloads,
   backups and recovery, credentials, and networking. Gate native-only
   features in the browser UI.
2. Port the vendored client's blocking HTTP calls and the app's blocking auth
   and sync entry points to async transport. Keep the Etebase ciphertext,
   MessagePack payloads, signatures, room keys, and Yjs update formats
   compatible. Add native-to-browser encrypted sync conformance tests before
   enabling browser sign-in.
3. Add offline app loading, update handling, static-host deployment, storage
   recovery, and desktop/mobile release validation. Local persistence does not
   establish encrypted sync or a releasable browser app.
