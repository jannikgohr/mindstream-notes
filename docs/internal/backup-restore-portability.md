# Backup and restore portability

Settings → Data & Backup exports one vault and the portable device
configuration needed to use it on another device. The user
guide is [Backup and restore](../backup-and-restore.md).

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

Account sessions, keystore keys, browser stores, IPC
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

Old workers that do not know this restore flow are kept out of it by the
storage contract version in `worker_registration.rs`.

## Verification

Rust tests cover export, preview, staging and startup reconciliation, both
restore choices, conflicts, removal receipts, approval gating, legacy archives
and interrupted publication. `src-tauri/scripts/supervised-backup-check.py`
runs the same path against real desktop workers in a disposable root and checks
cold restart and lease release. Platform results and the checks still to do are
in [Ubuntu VM QA](e2e/ubuntu-vm-qa.md).
