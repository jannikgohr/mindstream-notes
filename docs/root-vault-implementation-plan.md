# Root storage and concurrent vault implementation

Status: implemented. Reviewed on 2026-10-13. Root settings, concurrent desktop
vaults, opening preferences, handoff recovery, theme presets, device appearance,
global plugins and portable backups are delivered. Release QA remains below.

The [implementation history](root-vault-implementation-history.md) retains the
original estimates, dated slices and validation artifacts. Its older pending
lists are historical.

## Current delivery status

| Area                    | Current state                                                                                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage safety          | Locked ownership, restore/deletion journals, validated document recovery and retained migration inputs implemented. Process-crash and Linux guest hard-reset checks pass; Windows/host power-loss durability remains release QA. |
| Root and vault settings | Device and vault documents, field transactions, browser export/classification, credential migration and isolated worker stores implemented.                                                                                      |
| Concurrent runtime      | One coordinator and one process per open vault. Duplicate/focus routing, settings invalidation, save/service drains, tray, shortcuts, autostart and updater-session recovery implemented.                                        |
| Menu and handoff        | Remembered opening choices, modifier override, prepared targets, all-window saves, geometry transfer and durable recovery implemented.                                                                                           |
| Startup                 | Missing last-used vault opens a picker without recreating data. Compatible surviving workers can be adopted after authenticated ownership checks.                                                                                |
| Appearance              | Root presets, accent and UI font size implemented. Editor typography remains vault-specific.                                                                                                                                     |
| Global plugins          | Shared immutable packages/artifacts and device settings implemented. Approval, enablement and writable data remain per vault.                                                                                                    |
| Backup portability      | Version 2 archives include vault settings/data and portable device configuration/packages. Shared-device restore is opt-in and preserves conflicts. Version 1 archives remain readable.                                          |
| Release QA              | Windows/Linux native checks, Linux QA packages/updater, real pickers and integer scaling pass. Linux guest hard reset passes; host power loss, production-key platform and real display/macOS checks remain open.                |

Detailed contracts and evidence:

- [Storage ownership and recovery](storage-ownership-and-recovery.md)
- [Backup and restore portability](backup-restore-portability.md)
- [Global plugins](global-plugins-implementation-plan.md)
- [Theme presets and device appearance](theme-presets-implementation-plan.md)
- [Browser storage migration inventory](vault-browser-storage-audit.md)
- [Native validation commands](e2e/harness.md#concurrent-vault-checks)
- [Ubuntu VM QA and reset/updater procedures](e2e/ubuntu-vm-qa.md)

## Required behavior

Ordinary desktop startup uses the supervised coordinator. Isolated test devices
remain direct unless they request `--supervised-vaults`; browser fallback and
mobile keep their single-vault flows. A worker owns its vault for its lifetime.
There is no in-process database/session swap.

| Action                                  | Result                                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Select an open vault                    | Focus its existing window and retain the source.                                                                       |
| Select a closed vault with Ask          | Offer This window and New window, with a remember option.                                                              |
| Select a closed vault with a preference | Apply the preference; explicit alternatives remain accessible.                                                         |
| Ctrl or Command click                   | Open/focus in a new window and retain the source.                                                                      |
| Create a vault                          | Follow the same opening policy as an existing closed vault.                                                            |
| Close with unsaved work                 | Freeze editing, drain services and save every main/popout editor. Failed saves retain the vault.                       |
| Coordinator crash during handoff        | Keep the source if it is still open. Finish opening the target after saved source closure and physical lease release.  |
| Whole-app Quit                          | Save and close every worker before the coordinator exits.                                                              |
| Update restart                          | Reopen all previously open vaults, restore hidden/visible windows and focus, then consume the restart record.          |
| Normal cold startup                     | Open only the last-used vault; use the picker if it is unavailable.                                                    |
| Restore backup                          | Replace only the selected vault. Import shared configuration/packages only when selected; existing device entries win. |

Close progress uses the bottom-right toast stack. The persistent spinner has no
close button and disappears on completion or cancellation. Save and service
timeouts keep actionable failure feedback. Fault-injection fixtures intentionally
exercise those failures in disposable roots.

## Ownership

| App root                                                                         | Vault                                                                   |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Desktop preferences, language, opening policy, UI appearance and hotkey bindings | Content/editor preferences, dock layout and global-shortcut eligibility |
| User theme presets                                                               | Selected spellcheck languages and custom words                          |
| Immutable plugin packages/artifacts and `D` plugin settings                      | Plugin approvals, enablement, `V` settings and writable `plugin-data`   |
| Downloaded dictionary cache                                                      | Database, notes, attachments, imports, backups and restore journal      |
| Vault index and startup preference                                               | Account session, sync identity and encrypted signing identity           |

Only the coordinator owns global shortcut/tray/autostart registration. Shortcuts
target the most recently focused eligible vault. A sole eligible closed vault can
be opened for capture; multiple closed eligible vaults require a prior recency
choice. Unknown ownership suppresses dispatch rather than falling back to a
second local handler.

## Recovery and compatibility

Physical OS leases establish ownership. Registration records, PIDs and lock-file
presence alone do not. RootLock protects short read/modify/publish transactions;
it never crosses IPC waits or network operations. SQLite checkpoints and
validation precede database moves. Startup never sweeps live WAL files.

Handoff journals pin canonical directories, launch identities and request IDs.
Cancelled, completed or changed-owner operations cannot close a replacement
worker. Restore journals preserve the previous database and vault files, validate
pending hashes and resume before the worker opens its database. Plugin revocations
prevent older catalog recovery from resurrecting a removed installation.

The runtime contract in `worker_registration.rs` is authoritative: protocol 11,
storage contract 4. Incompatible surviving workers block adoption and new writers
before migration. Portable restore journals use version 2, which older binaries
must refuse; database-only legacy journals remain recoverable.

## Validation and remaining release QA

Rust formatting, Clippy and the full serial test suite are required before each
implementation commit. Affected frontend tests, Svelte, localization, theme
checks and production builds accompany UI changes. Native fixtures use disposable
roots, authenticated Quit and explicit checks that all coordinator/vault leases
are released.

Windows checks cover simultaneous workers, duplicate/focus routing, unsaved
main/popout edits, close failures, handoff recovery, startup retry/adoption,
shortcuts/tray and the development launcher. Linux X11 and nested Weston/Wayland
checks cover handoff, recovery, startup and observed window focus. These are
native development-build checks. The Ubuntu VM also passes optimized Debian
installation and a locally signed AppImage update, including tampered-signature
rejection and all-vault/popout/hidden-state restoration. It passes the real Linux
backup pickers and integer 200% scaling. See the linked VM report for evidence
and limits. An externally triggered Proxmox hard reset retained all acknowledged
settings writes and passed five recovery checkpoints plus repeat cold starts.

Remaining release QA:

- Windows directory-entry and physical host power-loss durability. Linux guest
  hard-reset publication/restore checks pass on the tested ext4 virtual disk.
- Production-key updater installation and packaged restart on Windows/macOS.
  Linux installation/restart passes with a disposable QA signing key.
- Real monitor, DPI and display-change behavior.
- Packaged macOS 14+ Dock/menu/Reopen, focus, hide/show and Cmd+Q behavior. The
  owner accepted deferral until a Mac is available for release testing.

## Future scope

Network-filesystem vaults, arbitrary external vault directories, multiple local
writers, ordinary cold-start reopening of the entire previous session, credential
portability, theme/plugin marketplaces and unrestricted theme stylesheets remain
separate features. Portable vault settings and plugin data are implemented in the
linked backup contract.
