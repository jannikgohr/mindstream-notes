# Storage ownership and recovery

Native schema settings use root `ui-settings.json` for device preferences and
vault `content-settings.json` for content/account preferences. Each versioned
document has a revision, a validated `.previous` copy and a `.migrated` record.
Initial migration retains raw browser buckets. Valid documents win over those
inputs; malformed required inputs refuse migration. Only the default vault can
inherit content from the old unscoped bucket. Unknown/plugin entries stay in
the vault, while dynamic `hotkey.*` bindings stay at the root. Plugin settings with `scope: "V"` use the vault database; `D` values use root
`plugin-settings.json`. Scripts and preview services read the merged backend values.

Appearance presets, accent and UI font size are device preferences in root
`ui-settings.json`. Editor font size and line height remain vault preferences.
`appearance-migration-owner.json` pins the startup-selected vault's canonical
directory before concurrent startup. Root values win; that vault seeds absent
accent/font values once. Root `.device-appearance-migrated` publishes after the
device document. Retries preserve an existing root value, and completion prevents
a reset from resurrecting retained vault fields. Those former vault fields stay
in `content-settings.json` as migration evidence and never override root values.
Browser fallback retains original bucket bytes under
`mindstream:appearance-source:v1:<vault>`.

Root `theme-presets.json` stores a versioned map of user presets. Built-in IDs
are immutable. Numeric, bounded OKLCH tokens cannot load CSS, scripts or URLs.
RootLock serializes catalog edits across workers. A missing preset displays the
built-in default without changing `appearance.preset`; restoring it restores the
appearance. Catalog recovery retains corrupt bytes and promotes only a validated
previous copy. Mode, accent and preset selection have independent precedence.

`hotkeys.globalShortcuts` is a vault boolean, defaulting to false. It determines
eligibility for system-wide actions; it does not move the shared key bindings
into the vault. A root `global-shortcuts-migration.json` intent pins the former
root value to the recorded legacy owner, or the selected migration vault when
no owner exists. Existing vault choices win. A vault `.global-shortcuts-migrated`
receipt is published after its settings and before removing the root source.
Retries and recovered old root copies cannot re-enable a cleared owner or seed
another vault. Unscoped browser values follow that same owner; explicit vault
buckets preserve their own choice. Invalid booleans or migration records stop
initialization with evidence intact. The worker storage contract is version 4;
incompatible live workers block adoption and shared-document migration.

The coordinator records vault focus in root `shortcut-recency.json`, separately
from overall last-used startup selection. Entries bind vault IDs to canonical
directories and include closed vaults. Live focus history wins while disk writes
are pending; persisted history survives coordinator restart. Selection reads
vault eligibility under RootLock without repairing a vault document. Disabled
vaults and pending deletions are excluded. A pending legacy owner can remain the
sole closed capture destination until its worker completes migration. With no
eligible usage history, the eligible startup preference wins, then index order.
This identifies a destination and does not itself authorize note creation.

Startup recovers a damaged recency document from a validated previous copy.
Unrecoverable history makes shortcut selection unavailable while retaining both
copies; manual vault opening remains usable. Runtime reads never overwrite
corrupt vault settings or silently choose another destination. Dispatch pins the selected physical directory, waits for an authenticated ready
worker, then rechecks eligibility, index membership, current binding and service
admission. Failure never silently chooses a different destination.

The root coordinator owns system-wide registrations. Defaults and supported
keys come from `src/lib/hotkeys/global-shortcuts.json`, also consumed by the
frontend. Root bindings are read under RootLock; OS calls and worker IPC happen
after releasing it. Readiness, eligibility edits, device edits and vault deletion
invalidate registrations. Unchanged bindings remain registered. Failed removals
stay tracked; callbacks must still match the current canonical binding. Failed
registrations/removals and the latest failed action appear in shortcut settings.
Workers never unregister a peer's bindings when their window closes.

Authenticated action requests use the same UUID through bounded socket retries.
The root retains terminal operation results; the target worker retains action
receipts for ten minutes, with a capacity of 1024. Reused IDs with changed inputs
are rejected. DB success remains cached even when focus/notification delivery
fails, so a lost response cannot create a second note. Frontend key dispatch
queries current coordinator ownership before invoking the same local command;
unknown or settling ownership suppresses local execution. Dev/test registration
remains disabled. The runtime contract in `worker_registration.rs` is
authoritative for protocol/storage versions; the shared shortcut manifest is
included in its compatibility hash. Coordinator shortcut routing and whole-app
shutdown pass Windows fixture checks. Packaged platform checks and menu/handoff
release gates remain required before enabling supervision by default.

All document operations hold the root OS lock. Set/reset operations patch one
field after rereading the document; they never save a whole frontend cache.
The caller's expected vault ID must match the running worker. Frontend profile
readiness waits for migration, and failed writes surface to callers. Focus and
same-worker popout notifications refresh caches from disk. A recovery can reduce
the revision, so caches accept that refreshed snapshot. Cross-worker invalidations reload each worker's own canonical documents.
Supervised desktop startup and browser migration are implemented. Remaining
release QA is tracked in the [current implementation status](root-vault-implementation-plan.md).

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
deletion attempts removal of both session and signing master keys. Vault settings
and plugin data have a [portable backup contract](backup-restore-portability.md).
Credentials and signing private keys remain bound to the destination device/vault.

Private worker close commands retain request IDs and expose queued, pending,
committing or failed status. Repeated IDs never start another save attempt.
Queued aliases attach before native dispatch, so cancellation cannot turn a
late callback into an unintended retry. Cancelled outcomes remain queryable for
ten minutes; unknown status reads do not allocate requests. An existing close
can be observed through a new alias. Committing proves the save/drain decision,
not process exit or ownership release. Coordinators must still observe actual
child exit or acquire the physical vault's OS lease before considering it closed.
Whole-app Quit uses this protocol and observes physical ownership release before
exiting the coordinator. Cancellation, save failure, unknown owners or timeout
leave the remaining workers usable. Durable handoff uses the same close receipts
and physical ownership checks.

Desktop menu observations distinguish ready, starting and unavailable owners.
Failed reads cannot imply closure or authorize deletion/restart switching. The
supervised opening command binds to the exact ready source launch and rechecks
the target's index/physical ownership. Source admission tracks the opening job;
the coordinator rejects new opening requests during Quit/update drain. Opening
another vault leaves the source running; requesting an existing target focuses
its window. This-window handoff and remembered opening preferences are implemented.
Interrupted handoff finishes opening the target once the source has saved and
closed, and retains the source while it is open.

The coordinator also owns tray, shortcut and autostart registration and update
installation. Update recovery records every open vault and main/popout window
before close, restores visibility/geometry/focus, and consumes the record only
after persistence readiness. A consumed record is retained without replay on a
normal cold launch. Coordinator revival adopts surviving physical owners without
opening another vault or activating a window. These paths pass embedded Windows
checks. Optimized Linux Debian installation and a locally signed AppImage update
also pass, including rejected signatures, both vaults, popouts, hidden state and
consumed restart behavior. Packaged macOS and production-key platform checks
remain open. See [the VM report](e2e/ubuntu-vm-qa.md).

## Verification limits

Windows tests cover killed owners, leftover lock files, interrupted restore and
delete boundaries, concurrent root field/index edits, validated previous-copy
recovery, and concurrent dictionary readers/publishers. Native app tests confirmed
duplicate rejection and reopening after forced termination. File contents and
Unix directory entries are flushed before publication. Windows directory-entry
reboot durability and packaged platform behavior remain release QA. Linux X11
and nested Wayland handoff/recovery/startup checks pass; see the harness guide.
The Ubuntu Proxmox guest hard-reset run retained the last externally acknowledged
settings revision and recovered both handoff and three restore checkpoints.
Repeated cold starts released all leases. Physical host power loss and Windows
directory-entry durability remain outside that result; see the VM report.
Never delete SQLite WAL files as a startup cleanup operation.

Global plugin packages use root `plugins/catalog.json`, immutable
`plugin-packages/<digest>` directories and OS leases in `plugin-leases`.
Installation generations bind approvals to a particular installation. Removal
publishes a revocation before a catalog tombstone, so recovery cannot restore its
authority. Reinstall needs fresh approval even in unopened vaults. Existing scripts
and preview services retain their old package lease; final release collects retired
files and unreferenced digest-addressed artifacts. Writable `plugin-data` stays in
the vault. Settings and migration sources survive removal.

Root `plugin-settings.json` records the startup-selected canonical vault directory
and one-time `D` key receipts. Existing root values win. Retained vault rows cannot
resurrect a reset value. RootLock guards field edits and catalog publication;
notifications are sent after its release. See the [global plugin plan](global-plugins-implementation-plan.md).

Portable backup format 2 carries vault settings and writable plugin data along
with immutable package files and portable device values. Restore replaces the
selected vault; shared settings/themes/packages import only when selected, and
existing device entries win. Imported third-party execution approval is cleared.
Version 2 restore journals validate database/resource hashes, preserve old vault
files and resume before opening the database. The worker storage contract is 4.
See [backup recovery and retained evidence](backup-restore-portability.md#validation-and-recovery).
