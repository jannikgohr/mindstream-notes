# Backup and restore portability

Implemented on 2026-10-13. Settings → Data & Backup exports one vault and the
portable device configuration needed to use it on another device.

## Archive contents

Version 2 ZIP backups contain:

- `manifest.json`: format/schema versions, account display/collection identity,
  content counts, database SHA-256 and a resource index with file sizes/hashes.
- `data.db`: a SQLite snapshot with notes, folders, attachments, custom dictionary
  words, vault plugin settings and the other database content. Third-party
  execution approvals, installation generations and physical source paths are
  cleared in the exported copy. The live database remains unchanged.
- `portable.json`: vault UI/content settings, shared UI/desktop preferences,
  device plugin settings and custom theme presets. Migration owners, physical
  paths and source receipts are not exported.
- `portable/plugin-data/`: writable vault plugin files, including empty folders.
- `portable/packages/<plugin-id>/`: the installed immutable package versions.
  Builtins travel in the application.

Account sessions, keystore keys, signing private keys, browser stores, IPC
credentials, window coordinates, the vault index and runtime journals stay on
the device. Downloaded plugin artifacts and dictionaries are caches and are not
included; download them again on the destination. Plugin configuration/data can
contain private values supplied by a plugin, just as note content can.

The database is a consistent SQLite snapshot. Files are copied into private
staging with checksums; a file that changes during copying fails export with a
retry message. This is not a transaction across arbitrary plugin file writes.
Export publishes a complete flushed ZIP through a unique temporary file and
atomic replacement. It cannot overwrite managed application storage files.

## Restore choices

The preview shows note/folder/attachment counts, account matching and portable
plugin data/package counts. Shared-device import starts unchecked.

**Restore** replaces the selected vault's database, UI/content settings and
plugin data. It preserves safety copies of the old database and files. Existing
credentials remain on the destination; the backend verifies collection identity
again before preserving sync metadata. A mismatch strips remote pointers and
marks content for syncing to the destination account.

Selecting **Also import shared device preferences, custom themes and plugin
packages** fills missing shared entries. Existing settings and theme/package IDs
win conflicts. An existing package removal receipt also wins, and a plugin
setting reset receipt cannot be undone by importing old values. This option can
add shared entries visible to other vaults, but does not restore their vault data.

Every imported third-party plugin needs approval in the restored vault, even
when the destination already has identical package bytes. Approval and enablement
in other vaults stay unchanged. Imported database rows cannot later seed `D`
settings implicitly, including when an unavailable plugin is installed later.

**Merge** imports only missing notes, folders and attachments. It leaves vault
settings, plugin data/packages and shared device preferences unchanged. The
shared-device checkbox applies only to Restore.

Version 1 database-only archives remain readable. Their Restore replaces the
database and clears third-party execution approval. Vault files and shared
preferences remain unchanged. Older apps reject the version 2 archive rather
than silently restoring only its database.

## Validation and recovery

Import rejects future formats/schemas, missing or duplicated entries, checksum
failures, unsafe or platform-dependent paths, file/directory collisions,
symlinks, special files and invalid settings/themes/packages before committing
a restore. Settings JSON, entry counts and expanded archive sizes are bounded.
Each import has a UUID staging directory. Cleanup validates the token and never
sweeps another active import.

Staging flushes `pending-restore.db` and `pending-restore-files/` before publishing
the version 2 `pending-restore.flag` operation. Startup validates the database and
resource hashes before preserving live data. It resumes database preservation,
installation and resource publication from the retained journal. No worker
becomes ready until completion. Shared edits use RootLock and preserve existing
fields on retry.

Database safety copies use `mindstream-pre-restore-*.db`. Vault file safety copies
and the restored resource bundle live under `backups/pre-restore-files-<hash>/`.
Preparations interrupted before the sentinel commits cannot apply automatically;
a later explicit restore archives those files under `backups/uncommitted-restore-*`.
Failed validation retains the operation and its inputs for inspection. Unused
import staging and retained safety evidence are not automatically deleted.

Worker storage contract 4 prevents incompatible old workers from participating
in the new restore flow. The current runtime versions are authoritative in
`worker_registration.rs`. Hard-reset verification is pending. Linux packaged
updates pass with a disposable QA signing key; production-key platform checks
remain release QA, separately from tested process-crash recovery.

## Verification

Rust tests exercise disk export → preview → staging → startup reconciliation,
both restore choices, conflicts/removal receipts, plugin setting resets, approval
gating, legacy archives, changed inputs and interrupted file/database publication.
Frontend tests cover preview parsing, the unchecked option and its IPC argument.

`src-tauri/scripts/supervised-backup-check.py` uses the real Rust export/staging
functions to prepare a disposable root, then launches real desktop workers,
checks restored values/data and approval gates, opens a separate unchanged vault
and verifies cold restart. It closes through authenticated Quit and verifies
every coordinator/vault lease. The Ubuntu VM run also exercised real Save As
and Open pickers, replacement confirmation and Restart now. See
[the VM report](e2e/ubuntu-vm-qa.md) for current results and remaining checks.
The optional Windows `--check-ui` case renders the actual choice dialog with a
fixture preview and verifies its unchecked default and returned selection. Backend replacement is tested
separately through the real export/staging/startup path.

Validation on 2026-10-13: Rust formatting and Clippy passed on Windows and Linux.
The full serial suites passed with 914 Windows and 917 Linux unit tests, plus one
integration test on each. The 23 affected frontend tests, Svelte diagnostics,
affected ESLint, localization checks and production build passed. Both platforms
passed the native backup fixture, including cold restart and lease release. Linux
also passed all ten handoff cases, focus checks and both startup cases.
The final Windows UI fixture verified the real dialog's unchecked default and
returned device option; its screenshot was inspected for layout and wording.

Evidence is retained under `.output/backup-portability-native-check/`,
`.output/backup-portability-ui-native-check/` and
`.output/linux-vault-check/backup-20261013-120658/`, alongside their build/test logs.
