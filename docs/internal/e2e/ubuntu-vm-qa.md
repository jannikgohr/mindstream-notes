# Ubuntu VM QA

Manual checks that need a whole Linux machine: a hard reset of the guest and
the packaged updater. Run them on a disposable VM with local packages; publish
nothing. What the app promises here is in
[storage ownership and recovery](../storage-ownership-and-recovery.md). They
last passed on Ubuntu 26.04.1 on 2026-10-13, together with real Linux file
pickers, an installed Debian package and 200% integer scaling.

Use an isolated desktop and D-Bus secret-service session for both. Persist the
fixture's keyring in its own XDG data directory and unlock it again after a
reset. Never unlock your real keyring with the fixture password, and never
commit endpoint credentials, browser stores, signing keys or fixture archives.

## Repeat a hard-reset check

Use a disposable VM or an agreed reset window. A guest reboot shuts down in
order and is not the interruption this tests.

Build the embedded debug executable after compiling the test helpers; a plain
`cargo test` can replace `target/debug/mindstream-notes` with a binary that
expects the development server:

```sh
cd src-tauri
cargo fmt -- --check
cargo clippy --locked -- -D warnings
cargo test --locked -- --test-threads=1
TAURI_CONFIG='{"build":{"devUrl":null}}' cargo build --locked --features tauri/custom-protocol
```

Prepare the checkpoints:

```sh
python3 src-tauri/scripts/linux-vm-reset-check.py prepare \
  --output /absolute/disposable/check \
  --exe src-tauri/target/debug/mindstream-notes \
  --test-exe /absolute/path/to/mindstream_notes_lib-test-executable
```

Wait for `RESET_READY`. Five durable checkpoints are prepared: handoff before
closure, handoff after acknowledged source closure, vault files preserved,
portable resources published, and database installed. The coordinators stay
alive until the reset.

From a separate host, capture this test executable's stdout to a local file:

```sh
MINDSTREAM_RESET_FIXTURE_ROOT=/absolute/disposable/check/settings \
  /absolute/path/to/mindstream_notes_lib-test-executable \
  ui_settings::tests::stream_vm_reset_receipts \
  --ignored --exact --nocapture --test-threads=1
```

The writer goes through the real locked settings transaction and prints each
receipt only after it is published. Keep the last complete `QA_RECEIPT` JSON on
the separate host. Reset through the hypervisor without a guest shutdown, then
copy that receipt back into a JSON file.

After boot, start the same isolated desktop and keyring session and run:

```sh
python3 src-tauri/scripts/linux-vm-reset-check.py verify \
  --output /absolute/disposable/check \
  --exe src-tauri/target/debug/mindstream-notes \
  --receipt /absolute/path/to/last-host-receipt.json
```

Verification requires a changed boot ID and a complete settings document at
least as new as the acknowledged receipt, with its values. Startup reconciles
all five checkpoints, checks SQLite integrity, keeps the peer vault intact and
asks again before running imported plugins. Every case quits through the
authenticated Quit and repeats a cold start.

At the "vault files preserved" checkpoint, the first coordinator start writes
English/system defaults before resources are imported, and those existing
values win. The two later checkpoints keep the imported values. The verifier
waits for worker readiness before reading SQLite, because coordinator start
alone doesn't mean the restore finished.

This covers a guest hard reset on one virtual disk and cache setup. It does not
prove physical power loss, Windows directory-entry durability or every
interruption instant.

## Repeat the packaged updater check

Build two optimised QA packages with the same disposable key and a localhost
endpoint. Keep the private key in an ignored directory with mode 0600. Only the
QA packages' own configuration may allow an HTTP update endpoint.

```sh
python3 src-tauri/scripts/linux-packaged-update-check.py \
  --output /absolute/disposable/update-check \
  --old /absolute/path/to/old.AppImage \
  --new /absolute/path/to/new.AppImage
```

The defaults are versions `0.1.15-qa.1` and `0.1.15-qa.2`, the identifier
`com.jannikgohr.mindstream-notes.qa` and the endpoint
`http://127.0.0.1:18090/latest.json`. The new AppImage's `.sig` must sit next to
it. The fixture serves a tampered payload first, then the real one, and checks
the file replacement, fresh worker identities, restored windows and a normal
cold start. These packages don't use `e2e-data-dir`, which turns off OS
integrations.

## Remaining platform checks

Updater installation with production keys on Windows and macOS, the packaged
macOS 14+ app (Dock, menu, Reopen, hide, Cmd+Q), moving windows between
monitors and fractional DPI changes are still release QA. macOS waits until a
Mac is available.
