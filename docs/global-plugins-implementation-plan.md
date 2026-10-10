# Global plugin packages implementation plan

Status: follow-up feature. Complete environment isolation, vault ownership,
WebView migration, and root transactions in the [concurrency plan](root-vault-implementation-plan.md)
before enabling global package mutation. Concurrent vaults do not depend on it.

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

## Validation and estimate

Test separate vault approvals, same-account vault independence, simultaneous
downloads/update/removal, changed permissions/signers, unopened-vault reinstall,
conflicting migration inputs, and interruption at each publication step. Keep
path/symlink protections and builtin trust checks.

Primary areas: Rust discovery/settings/plugin commands, frontend plugin stores
and management UI, manifests, coordinator package operations, and plugin tests.
Dictionary concurrency belongs to the core plan because it is already shared.

Budget 4 to 7 working days after core platform checks. Reassess native-tool
version pinning before committing to the estimate.
