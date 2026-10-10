# Storage ownership and recovery

Native schema settings use root `ui-settings.json` for device preferences and
vault `content-settings.json` for content/account preferences. Each versioned
document has a revision, a validated `.previous` copy and a `.migrated` record.
Initial migration retains raw browser buckets. Valid documents win over those
inputs; malformed required inputs refuse migration. Only the default vault can
inherit content from the old unscoped bucket. Unknown/plugin entries stay in
the vault, while dynamic `hotkey.*` bindings stay at the root. Plugin settings
with an external store continue to use the vault database.

All document operations hold the root OS lock. Set/reset operations patch one
field after rereading the document; they never save a whole frontend cache.
The caller's expected vault ID must match the running worker. Frontend profile
readiness waits for migration, and failed writes surface to callers. Focus and
same-worker popout notifications refresh caches from disk. A recovery can reduce
the revision, so caches accept that refreshed snapshot. Cross-worker broadcast
is pending coordinator implementation. Other browser persistence consumers
still need migration before each worker can use an isolated WebView store.

Native sidebar widths use root fields `appearance.leftSidebarWidth` and
`appearance.rightSidebarWidth`. Sorting, direction, and sidebar open/closed
state use vault fields. The legacy unscoped preferences bucket seeds those vault
fields only for the selected legacy vault; a root `.ui-preferences-migrated`
record prevents later vaults from inheriting it. Existing fields win. Required
malformed inputs or invalid records block initialization. The original browser
bucket remains unchanged. A former root sort-strategy value moves to the
selected vault before removing it from the root, retaining a previous copy.
Recovery of that old root copy cannot reseed another vault's sorting preference.
Native UI setters patch one field, refreshes update the live sidebar/sort state,
and failed saves restore canonical values and show an error toast.

Saved dock layouts now use vault field `ui.dockLayout`. Native initialization
imports the matching encoded vault bucket; only the default vault can fall back
to the historical unscoped layout. JSON shape/version, note ID and timestamp are
validated before publishing either settings candidate. A vault
`.dock-layout-migrated` record prevents reseeding, and explicit `null` preserves
a cleared layout across restarts. Existing values win and source browser bytes
remain intact. Layout writes require the running vault ID and report failures.
The cache returns a copy so dockview cannot mutate the canonical snapshot.

Release retains its historical data root and credential service. Dev uses the
`.dev` bundle identity and a persistent separate root. Test roots and browser
folders are explicit; all three real-app harnesses set both. Accounts remain
vault-specific. Environment names do not permit two owners of one physical vault.

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

Local filesystems are supported. Network filesystem locking/durability is outside
this plan. Older binaries without ownership locks remain unsafe against the same
vault; new binaries cannot force them to cooperate.

## Startup and root documents

Resolve environment identity and verify browser isolation before using a vault.
Under the root lock, validate/recover the vault index and reconcile pending
deletions. Resume a legacy profile migration only when its files are unambiguous.
Select the vault and acquire its lifetime lock before restore or SQLite opens.
Desktop settings then validate/recover and migrate before database mutation.
Restore recovery runs next; only successful reconciliation permits SQLite and
normal services to start. Worker readiness registration will follow in Phase 2.

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

A root desktop-settings migration marker prevents reseeding from a stale vault
when both current and previous root files are missing. Valid root values win;
vault sources and unknown fields are retained. Field patches reread current disk
state under the lock and increment a revision, preserving concurrent edits.
Recovery broadcasts must refresh caches even when a restored revision is older;
revision numbers alone cannot represent recovery.

## Deletion and dictionaries

Deletion takes the root lock and tries exclusive vault ownership. It writes a
root operation record and vault tombstone, removes the index entry, releases the
in-directory ownership handle, then removes files. Windows requires that handle
release. The root lock and tombstone block reopening during this sequence.
Interrupted deletion resumes from its retained record. Invalid records and paths
outside the canonical profiles directory are refused.

A dictionary manifest selects one immutable validated `.aff`/`.dic` generation.
Readers hold the dictionary lock while resolving/loading a pair. Publication is
one atomic manifest write; unpublished partial generations are ignored after a
crash. Removal publishes a tombstone before cleaning up legacy flat files, so an
interrupted cleanup cannot resurrect them. Caches refresh generations once per
request. Old/unpublished generations are retained pending bounded cleanup.
Malformed manifests or missing referenced files are preserved and refused.

## Collaboration identities

Native collaboration signing credentials live in an encrypted vault file. A
separate vault master key lives in the environment's OS keystore; authenticated
encryption binds file contents to both environment and vault identity. Server
and username determine the account entry. Reads/writes require the vault's active
account. Main and note windows serialize creation and retain the winning identity.

Existing browser keys import unchanged only for a matching account. Their source
remains until browser migration is verified. A missing keystore key with an
existing encrypted file, corrupt file, or malformed legacy key is a recovery
error. These conditions must never create a replacement signing identity. Vault
deletion attempts removal of both session and signing master keys. Full portable
credential/settings backup remains outside the current concurrency plan.

## Verification limits

Windows tests cover killed owners, leftover lock files, interrupted restore and
delete boundaries, concurrent root field/index edits, validated previous-copy
recovery, and concurrent dictionary readers/publishers. Native app tests confirmed
duplicate rejection and reopening after forced termination. File contents and
Unix directory entries are flushed before publication. Windows directory-entry
reboot durability and macOS/Linux runtime behavior still need platform tests.
Never delete SQLite WAL files as a startup cleanup operation.
