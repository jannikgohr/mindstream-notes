# Ubuntu VM QA

The current delivery contract remains in [the root/vault plan](../root-vault-implementation-plan.md).
These checks use disposable devices and local packages. No release was published.

## Environment

Ubuntu 26.04.1 on Proxmox, CPU type `host`, four virtual CPUs and 12 GB RAM.
Rust 1.97.1, Node 22.22.1, pnpm 10.34.7, GTK 3.24.52 and WebKitGTK 2.52.6.
Native tests run as the ordinary user with WebKit's sandbox enabled. X11 uses
Xvfb/Openbox; Wayland uses nested Weston with an X11 input seat.

T3 Code 0.0.45 CLI/server and desktop package are installed. The server runs as
a lingering systemd user service on loopback port 3773. The private test desktop,
VNC and noVNC services also start at boot. Ports 5901 and 6080 stay on loopback;
SSH forwarding exposes the desktop to the automation client. Codex and Claude
Code are installed and authenticated. Their credentials remain on the VM.
Fresh desktop onboarding completed and recognized both agents as ready.

## Results on 2026-10-13

| Check                                        | Result                                                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Rust formatting, Clippy with warnings denied | Passed                                                                                                                            |
| Full serial Rust suite                       | 917 unit tests and one integration test passed                                                                                    |
| Frontend suite                               | All 252 files and 3,048 tests passed                                                                                              |
| Svelte and production frontend/native builds | Passed                                                                                                                            |
| X11 handoff                                  | All ten cases, including observed focus, passed                                                                                   |
| X11 startup                                  | Discovery retry and surviving-worker adoption passed                                                                              |
| Nested Wayland                               | Seven handoff cases with focus, both startup cases and portable backup passed                                                     |
| Integer scaling                              | Normal/existing-target/source-closed recovery, startup and backup passed at 200% scaling                                          |
| Native portable backup                       | Vault/device conflicts, plugin approval, peer isolation and cold restart passed                                                   |
| Real Linux pickers                           | Save As, Open, unchecked shared-device option, selected import, replacement confirmation and Restart now passed                   |
| Installed Debian package                     | Two vaults, duplicate focus, Quit and single-vault cold startup passed                                                            |
| Signed AppImage update                       | Tampered signature rejected before closure; valid installation restored both vaults, source popout, hidden target and saved focus |
| Update consumption                           | Following cold startup opened one vault and retained the consumed restart record                                                  |
| Hard VM reset                                | Prepared; awaiting external reset and recovery verification                                                                       |

The picker run checked the restored SQLite database, vault settings, plugin data
including an empty directory, imported theme/package, retained device conflicts
and cleared third-party approval. It used real dialogs and backend operations,
without a synthetic preview or picker hook.

The packages use versions `0.1.15-qa.1` and `0.1.15-qa.2`, identifier
`com.jannikgohr.mindstream-notes.qa`, and a disposable signing key. Only their
temporary configuration permits a localhost HTTP update endpoint. Production
configuration, production signing keys and release metadata were unchanged.
These optimized packages enable the ordinary coordinator and updater; they do
not enable `e2e-data-dir`, which suppresses OS integrations.

The scaling run initially requested sizes below GTK's scaled minimum and
coordinates between logical pixels. The handoff fixture now scales its
synthetic geometry requests. Production geometry remains a physical-pixel
snapshot. Integer scaling in an isolated compositor does not cover moving a
window between physical monitors or changing fractional scale.

An Ubuntu WebKit renderer crash report occurred during the concurrent fault
runs; the native workflows subsequently completed and released their leases.
T3's disposable desktop process also produced a GPU shutdown report when its
entire systemd process group was stopped. Keep that evidence distinct from
successful workflow assertions. The CLI service continued running.

Evidence lives under `.output/ubuntu-vm-qa/` in the VM checkout and
`/home/jannik/qa/` for native roots. Selected result JSON and external reset
receipts are copied to the Windows checkout's `.output/ubuntu-vm-qa/`.
Do not commit endpoint credentials, browser stores, private signing keys or
generated fixture archives.

## Repeat a hard-reset check

Use a disposable VM or an agreed VM reset window. A guest reboot performs an
orderly shutdown and is not the interruption this fixture tests.

Build the embedded debug executable after compiling the test helpers. A plain
`cargo test` can replace `target/debug/mindstream-notes` with a binary configured
for the development web server. Finish preparation with:

```sh
cd src-tauri
cargo fmt -- --check
cargo clippy --locked -- -D warnings
cargo test --locked -- --test-threads=1
TAURI_CONFIG='{"build":{"devUrl":null}}' cargo build --locked --features tauri/custom-protocol
```

Use an isolated desktop and D-Bus secret-service session. Persist the fixture's
keyring in its own XDG data directory and unlock it again after the reset.
Never unlock the user's real keyring with the fixture password.

```sh
python3 src-tauri/scripts/linux-vm-reset-check.py prepare \
  --output /absolute/disposable/check \
  --exe src-tauri/target/debug/mindstream-notes \
  --test-exe /absolute/path/to/mindstream_notes_lib-test-executable
```

Wait for `RESET_READY`. The producer prepares five durable checkpoints:
handoff before closure, handoff after acknowledged source closure, vault files
preserved, portable resources published, and database installed. The app
coordinators remain alive until the reset.

From a separate host, capture this test executable's stdout to a local file:

```sh
MINDSTREAM_RESET_FIXTURE_ROOT=/absolute/disposable/check/settings \
  /absolute/path/to/mindstream_notes_lib-test-executable \
  ui_settings::tests::stream_vm_reset_receipts \
  --ignored --exact --nocapture --test-threads=1
```

The writer calls the real locked UI settings transaction. It flushes each
receipt to stdout only after publication returns. Retain the last complete
`QA_RECEIPT` JSON on the separate host. Reset through the hypervisor without a
guest shutdown, then copy that receipt back into a separate JSON file.

After boot, start the same isolated desktop/keyring session and run:

```sh
python3 src-tauri/scripts/linux-vm-reset-check.py verify \
  --output /absolute/disposable/check \
  --exe src-tauri/target/debug/mindstream-notes \
  --receipt /absolute/path/to/last-host-receipt.json
```

Verification requires a changed Linux boot ID, a complete settings document at
least as new as the externally acknowledged revision, matching font value and
retained accent. Native startup reconciles all five checkpoints, checks SQLite
integrity, keeps the peer vault intact and gates imported plugin execution.
Every case closes through authenticated Quit and repeats cold startup.

This covers a guest hard reset on the tested virtual disk/cache configuration.
It does not prove physical host power-loss durability, Windows directory-entry
durability or every possible interruption instant.

## Repeat the packaged updater check

Build two optimized QA packages with the same disposable key and localhost
endpoint. The private key belongs in an ignored directory with mode 0600.
Run the fixture on an isolated desktop/keyring session:

```sh
python3 src-tauri/scripts/linux-packaged-update-check.py \
  --output /absolute/disposable/update-check \
  --old /absolute/path/to/old.AppImage \
  --new /absolute/path/to/new.AppImage
```

Default versions are `0.1.15-qa.1` and `0.1.15-qa.2`; the identifier defaults
to `com.jannikgohr.mindstream-notes.qa` and the endpoint to
`http://127.0.0.1:18090/latest.json`. The new AppImage's adjacent `.sig` must
exist. The fixture serves a tampered payload first, then the valid artifact,
and checks file replacement, fresh worker identities, restart restoration and
normal cold startup. All roots and the local server remain isolated.

## Remaining platform checks

Production-key updater installation on Windows/macOS, packaged macOS 14+
Dock/menu/Reopen/hide/Cmd+Q, and real monitor/fractional-DPI transitions remain
release QA. macOS testing is deferred until a Mac is available.
