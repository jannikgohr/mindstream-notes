# Browser support

The first increment is a SQLite compatibility proof at `/sqlite-proof/`. The
notes UI still uses its existing browser mocks. Authentication, sync, and a
browser release are pending.

## Run the proof

Install Rust's Wasm target, Clang with a WebAssembly backend, LLVM's archiver,
and the binding generator pinned by `src-tauri/browser-wasm/Cargo.toml`.
On Ubuntu, `sudo apt-get install clang lld` supplies the C tools.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126 --locked
pnpm install --frozen-lockfile
pnpm build:wasm
pnpm dev
```

Open `http://localhost:1420/sqlite-proof/`. Save a marker and reload. Open the
same address in a second tab to check ownership. Close the database in the
first tab, then retry in the second.

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

The proof uses `.mindstream-sqlite-proof` in the origin's private filesystem,
with a separate `proof.sqlite3` database. It cannot open a native vault.
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
failure, timeout, and shutdown failure.

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
migrations, asset hash backfill, note models, note read queries, search queries
and ranking, patch deserialization, and note and tag CRDT operations. Native
modules forward to it and preserve their existing command signatures and
structured error codes. Migration SQL and CRDT encodings stay the same.

`src-tauri/browser-wasm` installs the browser VFS and exposes the proof's
operations. `src/lib/browser` holds the dedicated worker, request protocol,
validators, and asynchronous client. The proof page bypasses the main app
layout so initializing the mock app cannot affect its storage checks.

The proof's marker writes are test operations. They are not a substitute for
porting the app's note mutation pipeline.

## Remaining increments

1. Move note and folder mutations, asset bookkeeping, history, and local share
   state into the core. Keep read-only share guards, reference counting,
   tombstones, and CRDT normalization in the same transaction boundaries.
2. Define platform services for database creation, files, credentials, HTTP,
   and application events. Native services retain OS file access, keyrings,
   and Tauri event delivery. Browser services use OPFS, file pickers and
   downloads, explicit session storage policy, fetch, and worker events.
3. Extend the typed worker protocol to shared operations. Route
   `invokeOrFallback` through a platform adapter, retain mocks only in tests,
   and gate unsupported native commands and controls by capability.
4. Port the vendored client's blocking HTTP calls and the app's blocking auth
   and sync entry points to async transport. Keep the Etebase ciphertext,
   MessagePack payloads, signatures, room keys, and Yjs update formats
   compatible. Add native-to-browser encrypted sync conformance tests before
   enabling browser sign-in. Do not persist a plaintext saved session as a
   shortcut for the OS keyring.
5. Test shared mutations on both targets, run desktop and mobile regressions,
   then add offline app loading, update handling, static-host deployment,
   backup/export, and storage recovery. A successful SQLite proof alone does
   not establish encrypted sync or a releasable browser app.
