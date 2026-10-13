# Global plugin packages implementation plan

Status: implemented on 2026-10-13. Packages, artifacts and `D` plugin values
belong to the app root. Approvals, enablement, `V` values and writable data
remain in each vault. See [plugin usage](plugins.md) and
[storage recovery](storage-ownership-and-recovery.md).

## Ownership and behavior

- Root owns packages, immutable artifacts, and device-scoped plugin settings.
  Embedded builtin trust remains unchanged.
- Vault owns enablement, accepted hashes/signers/grants, vault-scoped settings,
  and writable `plugin-data`.
- A newly discovered third-party package starts disabled/unapproved in each new
  vault. Same-signer updates cannot widen permissions silently.
- Disable is vault-specific. Uninstall is device-wide and identifies affected
  vaults. Preserve configuration unless the user separately resets it.
- Installation generations prevent old approval from silently reactivating in
  unopened vaults after uninstall/reinstall.

## Sequence

1. Add root discovery, scope-aware backend settings, installation generations,
   and notifications. Scripts receive effective root/vault settings.
2. Add immutable package/artifact publication with hashes, unique staging,
   operation locks, and recoverable records. Distinguish different bytes with
   the same declared version.
3. Pin versions while scripts/native tools use them. Coordinate update/remove
   across workers and defer deletion until services release their versions.
4. Migrate vault installations: valid root installations win; identical packages
   deduplicate; otherwise prefer the selected vault and archive conflicts.
   Retain source files until completion and preserve only matching approvals or
   updates allowed by existing signer/permission rules.
5. Migrate `D` settings once. Root values win; otherwise seed from the selected
   vault and preserve conflicts. `V` settings and plugin-data stay in the vault.
6. Update management UI/docs for global removal, vault approval/disable, missing
   packages, reapproval, and deferred deletion.

## Publication and recovery

`plugins/catalog.json` maps IDs to an installation generation and an immutable
package digest. `plugin-packages/<digest>/` contains complete packages. This
storage digest includes signature bytes; approval still uses the verified signed
package digest. Different bytes with the same declared version remain distinct.
RootLock serializes publication and removal. Files are synced in a unique staging
directory, validated again, then renamed before the catalog commits. Interrupted
staging and unreferenced published copies are collected during the next operation.
Source folders remain intact, including migration conflicts. The catalog uses the
verified staged digest; changing source bytes during publication rejects the
operation before committing metadata.

Updates retain the installation generation. Removal records an append-only
revocation before committing a tombstone. Reinstall assigns a new generation.
Recovery of an older catalog cannot undo revocation. Vault database migration 28
records the generation observed by each vault. Even a vault unopened throughout
remove/reinstall must approve again, including legacy approvals not yet migrated.

OS shared leases pin package versions while scripts, native calls, downloads and
preview services use them. Removal immediately removes discovery/authority for
new work. Existing admitted work finishes with its pinned files. Exclusive lease
acquisition gates deletion, and the final release schedules collection. A worker
crash releases its OS leases; the next startup/operation collects retired files.
Versions referenced by the previous catalog remain available for recovery;
revocation overrides both catalog snapshots. Artifact paths include their declared SHA-256. Concurrent publication uses unique,
synced atomic files. Artifacts stay while an active or pinned package declares them.

Root `plugin-settings.json` pins the startup-selected migration vault before
workers start. Root values win; only this vault seeds missing `D` keys once.
Receipts prevent reset from importing retained database rows again. Runtime
contexts include stored values and manifest defaults. Preview services build the
same backend context instead of accepting frontend settings as authority.

Worker storage contract 3 refuses adoption of older workers before migration.

## Validation

Rust regression tests cover independent approvals and enablement, identical
reinstall in unopened/unmigrated vaults, same-version updates, leases and deferred
collection, concurrent publication/removal and downloads, retained migration
conflicts, interrupted publication, catalog recovery after removal, and one-time
`D` migration/reset. Existing signer/permission and traversal tests remain in use. Re-signing
identical content with another key must preserve the old pinned signer and gate
both that package and its later updates.
Frontend tests cover removal invalidation, reset propagation and operation failures.

`src-tauri/scripts/supervised-plugins-check.py` exercises two real Windows vault
workers, shared discovery, separate script contexts/approval, same-version updates,
remove/reinstall while one vault is closed, retained configuration and cold restart.

Validation completed on 2026-10-13:

- Windows: Rust formatting and Clippy passed; 905 unit tests and the plugin
  contract integration test passed. The production frontend and desktop builds
  passed. The final two-worker plugin fixture passed and released its leases.
- Frontend: 469 tests passed; Svelte reported no errors or warnings. Affected
  ESLint, theme and localization checks passed. The management screen was also
  inspected in the running desktop app.
- Linux X11: Rust formatting and Clippy passed; 907 unit tests and the plugin
  contract integration test passed. All ten handoff cases, focus checks and both
  startup cases passed, with coordinator and vault leases released.
- Linux Wayland: the same checked desktop binary passed all ten handoff cases,
  focus checks and both startup cases, with all leases released.

Windows plugin fixture evidence is retained under
`.output/global-plugins-final-native-check/`; Linux X11 evidence is under
`.output/linux-vault-check/native-20261013-011115/` and
`.output/linux-vault-check/startup-20261013-011403/`. Wayland evidence is under
`.output/linux-wayland-check/native-20261013-084106/` and its adjacent startup
fixture directory.

Packaged macOS validation remains part of the previously deferred platform QA.
