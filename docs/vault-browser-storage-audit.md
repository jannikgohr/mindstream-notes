# Vault browser storage audit

Audit date: 2026-10-10. This inventories persistence outside the vault database
before WebView store isolation. It records migration work; no production storage
or credential migration is implemented by this audit.

The settings schema is only part of the problem. Searching `src` for
`localStorage`, `sessionStorage`, and `indexedDB` finds 26 source files including
comments and consumers. The table below groups actual readers/writers; remaining
matches describe or consume these stores. No direct IndexedDB use was found in
application sources. Browser libraries/caches still need a runtime inventory.

## Persistence owners and destinations

| Current key or store                                                      | Source                                                                                              | Scope and migration                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notes-app:settings:v1`                                                   | `settings/store.svelte.ts`, `app.html`                                                              | Mixed legacy document. Export device settings to the locked root settings document. Legacy vault values seed only the migrated default vault, as current load rules specify. Keep unknown keys as migration evidence.                                                         |
| `notes-app:settings:v1:vault:<id>`                                        | `settings/store.svelte.ts`                                                                          | Vault settings and account dynamic values. Export only to the matching vault, preserving the raw bucket's unknown plugin values for classification. Do not classify unknown plugin values as device-owned.                                                                    |
| `notes-app:preferences:v1`                                                | `preferences.ts`, `state.svelte.ts`                                                                 | Mixed and unscoped. Sidebar widths are device UI preferences; sorting and open/closed layout state belong to the vault. Existing unscoped values can only seed the selected legacy vault.                                                                                     |
| `notes-app:dock-layout:v1`, `notes-app:dock-layout:v1:vault:<encoded id>` | `api/layout.ts`                                                                                     | Vault layout, open note IDs, active note. Preserve per-vault snapshots. The unscoped legacy snapshot seeds default only. Never copy note IDs into unrelated vaults.                                                                                                           |
| `notes-app:file-tree-create-toolbar:v1`                                   | `components/file-tree-toolbar-preferences.ts`                                                       | Device toolbar preferences. Preserve together with the existing legacy-toolbar detection rules.                                                                                                                                                                               |
| `notes-app:language`                                                      | `settings/i18n.svelte.ts`, `settings/registry.svelte.ts`                                            | Device language cache. Root/backend becomes authoritative. Hydration must not save an old cache over a newer root revision.                                                                                                                                                   |
| `mode-watcher-mode`                                                       | mode-watcher, `settings/registry.svelte.ts`, `api/window.ts`, `api/desktop-settings.ts`, `app.html` | Device mode cache. Root mode wins; maintain per-store first-paint caches and update popouts.                                                                                                                                                                                  |
| First-paint appearance values in `notes-app:settings:v1`                  | `app.html`                                                                                          | Device appearance cache. Seed from root before showing the window and refresh on revisions. Vault editor typography remains vault-scoped.                                                                                                                                     |
| `mindstream:collab-signing-key:v1:<encoded server>:<encoded username>`    | `sync/collab-signing-key.ts`                                                                        | Account credential material currently shared across vaults of one account. Preserve existing keys for matching vault accounts; move to vault credential storage. Never export private key material to logs or generic root settings. Do not regenerate keys during migration. |
| `notes-app:mobile:displayMode`                                            | `mobile/state.svelte.ts`                                                                            | Device mobile display preference. Mobile keeps its current single-vault behavior.                                                                                                                                                                                             |
| `notes-app:mobile:favourites`                                             | `mobile/state.svelte.ts`                                                                            | Legacy content migration into note data. Assign to the selected legacy vault; retain source until DB commit.                                                                                                                                                                  |
| `mindstream.pdf.signatures.v1`, `mindstream.pdf.signature.v1`             | `pdf/signature-storage.ts`                                                                          | Legacy content migration into vault signatures. Current migration writes DB then removes keys. Isolation migration must assign them once, not replicate them into every vault.                                                                                                |
| `mindstream.mock.signatures.v1`                                           | `api/mock-store.ts`                                                                                 | Browser-only mock content. Keep separate from Tauri credentials/content migration.                                                                                                                                                                                            |
| `mindstream:boot-reloads` in sessionStorage                               | `app.html`, `routes/+page.svelte`                                                                   | Ephemeral document reload budget. Do not migrate or share across worker lifetimes.                                                                                                                                                                                            |
| Hotkey settings, including dynamic command bindings                       | `hotkeys/store.svelte.ts`, `hotkeys/migrations.ts`, settings store                                  | Device settings. Migrate legacy command IDs, publish one root revision, and give the coordinator authoritative bindings. No per-window global registration.                                                                                                                   |
| Plugin settings                                                           | `plugins/settings-store.svelte.ts`, `plugins/settings-bridge.ts`, `api/plugins.ts`                  | Already stored in the vault DB. Device-scoped plugin values move in the separate global-plugins project. Preserve enabled/approved state per vault.                                                                                                                           |

The pinned schema currently declares 28 device-scoped settings and 42
vault-scoped settings, with additional action/custom entries. Dynamic account
and hotkey/plugin IDs require their existing resolver rules. Counting schema
entries is not proof that browser state is isolated.

## Credential migration progress

Native schema settings now migrate to root `ui-settings.json` and vault
`content-settings.json`, with individual locked edits and validated recovery
copies. Dynamic `hotkey.*` bindings use the root; unknown/plugin entries remain
with the vault until their persistence owner migrates them. Raw browser buckets
remain intact. Account preferences require the matching vault bucket, except
the default vault's historical unscoped fallback. Focus and same-worker events
reload canonical settings; cross-worker broadcast remains pending. This covers
the schema store only, not the other browser consumers listed above.

The mixed `notes-app:preferences:v1` bucket is also migrated in native builds.
Sidebar widths use root fields; sort strategy/direction and sidebar open state
use vault fields. Existing documents win, and the unscoped content preferences
seed only the first selected legacy vault. Native writes leave that browser
bucket intact and patch individual document fields. Live UI state refreshes
with the canonical snapshot; failed writes roll back and show feedback. The
schema's sort-strategy scope changed from device to vault, with compatibility
for the preceding root document and recovery copies.

On 2026-10-10 native collaboration signing material moved to
`<vault>/collab-signing-credentials.json`, encrypted with ChaCha20-Poly1305 and
a vault master key in the environment's OS keystore. The authenticated context
binds it to that environment and vault. Username/server account IDs are separate
inside the encrypted vault map. The backend checks the active account before
serving credentials and validates matching P-256 public/private keys.

Native reads prefer stored vault material. If none exists, they import only the
matching legacy browser key and retain its source. Corrupt legacy/native keys
and unavailable keystore keys stop migration rather than regenerate identities.
Native writes no longer put new private keys in localStorage. Browser-only mode
keeps its existing localStorage fallback. Export of legacy keys for accounts in
unopened vaults remains required before WebView store isolation; this lazy import
does not complete that export. Generic root snapshots must exclude private keys.

## Migration sequence

1. Acquire environment/root migration ownership before opening the legacy
   browser store. Keep older and new workers out of it during export.
2. Export a versioned snapshot with source origin, selected vault identity,
   schema version, and checksums. Treat credential material separately. Retain
   unknown keys and malformed values for recovery rather than discarding them.
3. Classify using schema scopes, raw vault buckets, known unscoped stores, and
   matching account metadata. Resolve root values first; never overwrite valid
   root values with a stale browser cache.
4. Commit root and per-vault destinations using operation records. Record each
   destination receipt so interruption/retry does not reseed user changes.
5. Open the isolated store for the selected vault and seed only its values and
   current root caches. Main and popout windows use the same store identity.
   Unopened vaults can migrate from the retained snapshot when first opened.
6. Mark completion only after verifying destinations and a restart. Keep the
   legacy snapshot until the recovery/retention policy permits removal.

Tests must cover two existing vaults, identical account names on different
servers, same-account vaults, a new vault, default/unscoped legacy values,
unknown plugin IDs, invalid JSON, interrupted export/import, dev/release origins,
and stale first-paint caches. Fixtures must not contain real credentials.

The WDIO harness already overrides WebView2 folders on Windows and XDG data/cache
paths on Linux through `helpers/worker-isolation.ts`. Those protect simulated
devices. Phase 1 now also gives each simulated device an explicit root and
root-specific credential service. Shared-root concurrent-vault tests and isolated-device tests must be
separate modes. Keep both multiremote configurations.
