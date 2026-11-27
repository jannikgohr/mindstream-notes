# Storage ownership and recovery

Who owns each piece of on-disk state, how concurrent vault workers share it, and
how startup recovers it. The runtime contract in `worker_registration.rs` is
authoritative for protocol and storage versions; workers on an incompatible
contract are kept out of shared-document migration and restore.

## Where settings live

| Document                                            | Holds                                                                                                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| root `ui-settings.json`                             | device preferences: appearance preset, accent, UI font size, sidebar widths, `hotkey.*` bindings                                                                       |
| vault `content-settings.json`                       | content and account preferences: editor font size and line height, sorting, sidebar open state, `ui.dockLayout`, `hotkeys.globalShortcuts`, unknown and plugin entries |
| root `theme-presets.json`                           | user theme presets, see [theming](theming.md)                                                                                                                          |
| root `shortcut-recency.json`                        | which vault had focus last, for global shortcuts                                                                                                                       |
| root `plugins/catalog.json`, `plugin-settings.json` | installed packages and device (`D`) plugin settings, see [plugin host internals](plugin-host.md)                                                                       |
| vault database                                      | notes and vault (`V`) plugin settings                                                                                                                                  |

Each versioned document has a revision, a validated `.previous` copy and a
`.migrated` record. Settings operations patch one field after rereading the
document under the root lock; they never save a whole frontend cache. The
caller's expected vault ID must match the running worker. Cross-worker
invalidations make each worker reload its own documents, and because a recovery
can lower the revision, caches accept a refreshed snapshot even when its
revision is older.

### Migrations into this layout

Values used to live in browser storage and, for some fields, in the other
document. Every migration follows the same rules:

- Existing values win. A migration only fills what is absent.
- Sources are kept: browser buckets keep their bytes, and former vault fields
  stay in `content-settings.json` as evidence but never override root values.
- When an old value had no vault, one owner is pinned before concurrent startup
  (`appearance-migration-owner.json`, `global-shortcuts-migration.json`), and
  only that vault, or the default vault, may inherit it.
- A receipt (`.device-appearance-migrated`, `.global-shortcuts-migrated`,
  `.ui-preferences-migrated`, `.dock-layout-migrated`) is published after the
  destination is written and before the source is removed, so a retry or a
  recovered old copy cannot reseed another vault or resurrect a reset value.
- Malformed required inputs or invalid migration records stop initialization
  with the evidence intact.

The code is in `src-tauri/src/ui_settings.rs`.

## Global shortcuts

The coordinator owns system-wide registrations. Defaults and supported keys
come from `src/lib/hotkeys/global-shortcuts.json`, which the frontend reads too.
A vault takes part only when its `hotkeys.globalShortcuts` is on (default off).
Bindings are read under the root lock; OS calls and worker IPC happen after it
is released. Workers never unregister a peer's bindings when their window
closes. Failed registrations and the latest failed action show in shortcut
settings. Development and test builds register nothing.

The destination is the eligible vault that had focus most recently
(`shortcut-recency.json`), then the startup preference, then index order.
Dispatch pins that directory, waits for an authenticated ready worker, then
rechecks eligibility and ownership. It never silently picks another vault, and
an unrecoverable recency document disables shortcut selection rather than
guessing. Action requests reuse one UUID across retries; the worker keeps
receipts for ten minutes, up to 1,024, so a lost response cannot create a second
note.

## Locks

Vault ownership uses an OS file lock on `.vault.lock` in the canonical vault
directory. The database retains the handle until its connection closes. Handles
are non-inheritable; helper children cannot accidentally retain ownership. The
root lock is `.root.lock` and covers short index/settings transactions. Dictionary
operations use their own `.root.lock` inside the dictionary directory, so parsing
or publication does not hold the general app root lock. Network work holds none.

Acquire the root lock before vault ownership when selecting, migrating or
deleting. Workers retain vault ownership for their lifetime and may later take
short root locks for settings. Root operations never wait indefinitely for vault
ownership: they try it once and refuse if held. Do not hold the general root lock
across IPC, editor flushes, network calls or worker readiness waits. Dictionary
readers and publishers do not acquire vault or general-root locks.

The OS releases locks on process termination or reboot. A remaining lock file is
normal and is reused. Never remove a lock file to take ownership; that can create
two locked file identities while a live owner still has the old handle. PIDs,
heartbeats and file timestamps cannot authorize takeover.

Only local filesystems are supported. Older binaries without ownership locks
remain unsafe against the same vault; new binaries cannot force them to
cooperate.

Release, development (`.dev` bundle identity) and test builds use separate data
roots and credential services. Test roots and browser folders are always
explicit. Accounts are per vault.

## Write gate in the frontend

The locks above protect the vault files. A window can still hold stale state in
memory: a browser tab refused the database lock runs the whole app with an
empty tree, and localStorage is shared between tabs. So the frontend writes
nothing until its vault is open and the notes loaded.

`src/lib/storage/vault-access.svelte.ts` holds one state per window. It starts
`pending`, becomes `ready` when the tree store's load succeeds, and becomes
`unavailable` when a load fails. A lost browser worker connection returns it to
`pending`. Writes wait while pending, and a write that arrives before anything
has loaded the vault starts the load through the tree store's registered probe.
Writes fail with `VaultNotReadyError` while unavailable.

Three places enforce it:

- `invokeTauri` and `invokeOrFallback` in `src/lib/api/core.ts` hold every
  command that `src/lib/storage/command-access.ts` marks as a write. The table
  covers every `TauriCommandName`, so a new command does not compile until it
  is classified. A command missing at runtime counts as a write.
- `src/lib/browser/vault.ts` applies the same check before any worker request,
  including backup, restore and import calls that bypass `invokeOrFallback`.
- `src/lib/storage/app-storage.ts` writes app localStorage keys. Held writes
  keep the latest value per key and flush when the vault is ready; an
  unavailable window drops them. A tab that recovers reloads its settings from
  storage before saving, so its startup snapshot never replaces newer values.

ESLint rejects direct `localStorage` writes and the raw Tauri `invoke` in `src/`.
The exemptions are listed in `eslint.config.js`: draft recovery, which must keep
typing safe exactly when the vault is gone, the vault picker window, which has
no vault, the error reporter and the e2e mock store. Tab-local `sessionStorage`
is not shared and stays direct.

## Startup and root documents

Resolve environment identity and verify browser isolation before using a vault.
Under the root lock, validate/recover the vault index and reconcile pending
deletions. Resume a legacy profile migration only when its files are unambiguous.
Select the vault and acquire its lifetime lock before restore or SQLite opens.
Desktop settings then validate/recover and migrate before database mutation.
Restore recovery runs next; only successful reconciliation permits SQLite and
normal services to start. Supervised workers register their exact launch identity
and report readiness only after native settings initialization. Legacy browser
export/classification finishes before isolated worker stores open.

Index and desktop-settings writes validate the current file, publish its
`.previous` copy, then atomically publish the new file. An ordinary save never
repairs corrupt state by overwriting it. Current valid documents win over backups.
For missing/corrupt current documents, startup validates the previous copy.
Corrupt bytes are retained in a uniquely named `.corrupt-<UUID>` file before a
valid previous copy is promoted. Invalid/ambiguous copies remain intact and stop
startup. A previous index referencing a deleted vault is refused unless a retained
matching deletion record permits reconciliation. Missing selected directories
never become empty replacements.

Recovery may roll back the latest settings/index change. Newly created vault
directories are retained even if the recovered older index does not name them.
The recovery picker still needs an explicit salvage/import path for these orphan
vaults. They must not be swept as temporary files. Lost indexes with multiple vault
directories require that recovery path; no arbitrary vault is selected.

Never delete SQLite WAL files as a startup cleanup operation.

## Deletion and dictionaries

Deletion takes the root lock and tries exclusive vault ownership. It writes a
root operation record and vault tombstone, removes the index entry, releases the
in-directory ownership handle, then removes files. Windows requires that handle
release. The root lock and tombstone block reopening during this sequence.
Interrupted deletion resumes from its retained record. Invalid records and paths
outside the canonical profiles directory are refused. Deletion also tries to
remove the vault's session key.

A dictionary manifest selects one immutable validated `.aff`/`.dic` generation.
Readers hold the dictionary lock while resolving/loading a pair. Publication is
one atomic manifest write; unpublished partial generations are ignored after a
crash. Removal publishes a tombstone before cleaning up legacy flat files, so an
interrupted cleanup cannot resurrect them. Caches refresh generations once per
request. Old/unpublished generations are retained pending bounded cleanup.
Malformed manifests or missing referenced files are preserved and refused.

## Closing windows and vaults

Desktop close requests keep the webview alive until its editors and settings
finish saving. A popout close flushes that window alone and destroys it only
after a successful acknowledgement; a failed or timed-out save leaves it open
for retry, and its source tab returns only after destruction. Whole-vault close
refuses to start while a popout close is pending.

Close commands carry request IDs, and a repeated ID never starts another save.
"Committing" proves the save decision, not that the process exited: the
coordinator must still see the child exit or take the vault's OS lock before it
treats the vault as closed. Quit, vault handoff and update installation all go
through this protocol. Cancellation, a failed save, an unknown owner or a
timeout leave the remaining workers usable, and a failed status read never
implies closure.

Update recovery records every open vault and window before closing them and
restores visibility, geometry and focus afterwards. Coordinator revival adopts
surviving workers without opening another vault or activating a window.

## Concurrent vault platform checks

Linux compositor behaviour and geometry constraints are recorded in
[the harness guide](e2e/harness.md#concurrent-vault-checks), and the Linux
results in [Ubuntu VM QA](e2e/ubuntu-vm-qa.md).

Remaining release QA:

- Windows directory-entry and physical host power-loss durability.
- Production-key updater installation and packaged restart on Windows/macOS.
- Real monitor, DPI and display-change behaviour.
- Packaged macOS 14+ Dock/menu/Reopen, focus, hide/show and Cmd+Q behaviour.
  The owner accepted deferral until a Mac is available for release testing.
