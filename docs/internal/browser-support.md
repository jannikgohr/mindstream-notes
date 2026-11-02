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

Open `http://localhost:1420/`, create and edit a note, then hard reload.
`pnpm dev` builds the worker Wasm before starting Vite. `pnpm build:browser`
builds both Wasm and the static frontend. Tauri uses
`pnpm dev:native` and keeps its existing native toolchain requirements.

## Testing modes

| Command             | Storage                                           | Default URL              |
| ------------------- | ------------------------------------------------- | ------------------------ |
| `pnpm dev`          | Normal persistent browser vault                   | `http://localhost:1420/` |
| `pnpm dev:fixtures` | Seeded in-memory UI fixtures, discarded on reload | `http://localhost:1421/` |
| `pnpm dev:qa`       | Persistent SQLite test vault named `qa`           | `http://localhost:1422/` |

`dev:fixtures` skips the Wasm build. `dev:qa` builds Wasm and uses the same
worker and shared Rust operations as the normal app. Override the port with
`--port 1423`. To keep another set of QA data, set
`VITE_BROWSER_TEST_VAULT=review pnpm dev:qa`. Names use 1 to 48 lowercase
letters, digits, or hyphens and start with a letter or digit. Invalid names
fail instead of falling back to the normal vault.

The QA badge shows the active test vault. **Reset test data** closes the
current worker and reloads. The fresh worker obtains that test vault's lock,
removes its OPFS directory, and creates a seeded database. Its pending drafts
and retained recovery copies are cleared before the app reads any notes.
Normal vaults, other test vaults, and their recovery data remain intact, even
when they share an origin. Close other tabs using this test vault before
resetting. Reset runs once during startup, before any notes load. A refused or
interrupted reset blocks notes with an error, including after a reload. It
never retries through later storage calls. Close the other owner, then click
**Reset test data** explicitly to retry.

Reset clears note data and recovery copies for this test vault. It keeps
settings, onboarding progress, and the saved tab layout. Vaults on the same
origin share those preferences and layout; tabs for deleted notes are dropped.
The normal development and build commands force normal storage even if the
shell or `.env.local` contains testing flags. Use the dedicated fixture or QA
commands to select those modes.

`pnpm build:fixtures` and `pnpm build:qa` produce the corresponding static
builds. Serve them with `pnpm preview --port 1421` or `--port 1422`.
These modes are baked into the build; preview does not switch storage modes.
Use `pnpm build:browser` for a normal persistent browser build.

`pnpm test:e2e` builds the fixture mode for UI tests. `pnpm test:sqlite` checks
the normal persistent backend in fresh browser contexts, retaining each
context during reload and second-tab checks. `pnpm test:qa` verifies the
isolated vault and reset action against real SQLite, including normal and
other test vaults on the same origin. Its Wasm build runs before Playwright
starts the server timeout. WebKit uses a temporary profile and
skips storage cases when OPFS is unavailable.

## Persistence and ownership

The app permits one owning tab per vault, browser profile, and origin. A second tab
reports that the database is already open. Close the owner and reload the
second tab to take ownership. Browser editors synchronously copy pending content
into a localStorage recovery journal before their save debounce. The next owner
replays that content into SQLite before reading the vault. Successful saves
remove only their own recovery copy, preserving edits made while a save waits.
Editor saves carry a token that SQLite commits in the same transaction as the
note. Recovery can identify an earlier committed save even if its response was
lost or the backend normalized the content. A later independent content write
invalidates that token, including writes that restore identical content.
Recovery never recreates purged notes or changes note metadata. Copies that
conflict with newer saved content, fail validation, or cannot be written are
retained separately, with a notice and a download action. They do not block
opening other notes. The journal stores CRDT bytes as base64 to reduce quota use.
It uses the same browser profile and origin as OPFS; clearing site data removes both stores.
If recovery storage is unavailable or full, SQLite saves still run, but pending
edits need a save acknowledgement before closing the tab.

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
failure, timeout, reconnecting after failure, and shutdown failure. Real-app tests create and edit a note
through the existing Svelte editor, reload with the HTTP cache disabled, close
the tab, and reopen the note. Immediate reload and close cases exercise the
save debounce, including source edits before they reach the live document.
They also verify folders, tags, favourites,
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

The pinned VFS is patched locally in `src-tauri/vendor/sqlite-wasm-vfs`.
Its upstream reserved-lock callback always reports a competing connection,
which prevents hot-journal rollback after an interrupted write. The patch uses
the app's one-connection-per-file rule to permit recovery and flushes pool
filename metadata. A deterministic browser test forces cache spill, terminates
the worker inside an uncommitted transaction, and checks that all 300 original
rows are restored. See the [upstream report](https://sqlite.org/forum/info/ccf76ca4225ab38f)
and the vendored `PATCHES.md` before updating this dependency.

## Shared code

`src-tauri/storage-core` has no Tauri dependency. It owns the canonical
migrations, note and folder mutations, attachment bookkeeping, history, local
share permissions and scope changes, trash operations, signatures, PDF text,
word counts, setup notes, search, ink state writes, and note and tag CRDT operations. Native
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

## Getting data out

**Export vault** downloads one zip with the same layout the app writes to a
folder. It holds Markdown, drawings, PDFs, and attachments, and leaves out the
trash. The zip format used here stops at 4 GB and 65,535 files. Notes past that
limit count as export errors in the result, and the archive stays valid.

## Native-only features

The browser hides what only the native app can do: the tray, start on login,
global shortcuts, the custom title bar, the signed updater, the data folder,
vault window choices, and Android live ink. In-app keyboard shortcuts still
work. Note popouts are hidden too, because a second tab cannot own the vault.

Mark a setting, section, or category with `"nativeOnly": true` in
`src/lib/settings/schema.json` to hide it in a browser. Keep `platforms` for
OS filtering. It matches a browser by the OS it runs on, so a Linux browser
counts as `desktop`. `editor.desktopToolbar` is an example of a desktop setting
that belongs in the browser.

## Remaining increments

Plugins stay limited to the bundled core plugin until a later project, and
LanguageTool checks stay out of the browser.

1. Complete platform services for native file integrations, browser downloads,
   backups and recovery, credentials, and networking.
2. Add spellcheck in a worker and separate vaults on one origin.
3. Port the vendored client's blocking HTTP calls and the app's blocking auth
   and sync entry points to async transport. Keep the Etebase ciphertext,
   MessagePack payloads, signatures, room keys, and Yjs update formats
   compatible. Add native-to-browser encrypted sync conformance tests before
   enabling browser sign-in. Each server hosts the web app on its own origin,
   so the server needs no CORS support.
4. Add offline app loading, update handling, storage recovery, and
   desktop/mobile release validation. Local persistence does not
   establish encrypted sync or a releasable browser app.
