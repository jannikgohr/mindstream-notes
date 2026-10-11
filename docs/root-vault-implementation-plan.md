# Root storage and concurrent vault implementation plan

Status: restore safety, atomic document writes, environment identity, vault
ownership, root desktop settings, dictionary publication, root recovery, and
vault signing credentials are implemented and pass the Windows checks.
Schema settings now use root/vault documents. Opt-in supervision exports legacy
browser state before opening isolated vault workers. Coordinator recovery,
platform activation, shared OS integrations and the vault-opening UI remain
pending; normal startup and existing isolated test devices still use direct mode.

Global plugin packages and theme presets are separate follow-up projects:

- [Global plugins plan](global-plugins-implementation-plan.md)
- [Theme presets plan](theme-presets-implementation-plan.md)

## Required behavior

| Action                                              | Result                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Normal launch with open workers in this environment | Restore and focus the most recently used vault window, including a hidden window.    |
| Normal launch with no workers                       | Open the last-used vault, or show a picker if unavailable.                           |
| Select a closed vault without a preference          | Offer "Open in this window" and "Open in new window", with "Remember this decision". |
| Select a closed vault with a preference             | Use it; explicit alternative actions remain available.                               |
| Ctrl + left click a vault                           | Request a new window regardless of the preference.                                   |
| Request an already-open vault                       | Focus its existing window and keep the source vault running.                         |
| Change the opening preference                       | Device settings offer "Ask every time", "This window", and "New window".             |
| Open two vaults using one account                   | Allow. Account identity is not a local ownership key.                                |
| Delete an open or hidden vault                      | Refuse, including ownership by another worker.                                       |
| Reboot after a crash                                | Acquire OS locks and reconcile operations without manual lock-file removal.          |

"Open in this window" means worker handoff. Prepare the target at the source
window's geometry, flush the source, then activate the target and exit the
source. The native window may be replaced. Failed preparation or flushing keeps
the source open. Preserving the exact native window is outside this plan.

Concurrent-window UI is desktop-only. Mobile retains its single-vault/restart
flow and adopts compatible storage and recovery fixes.

## Ownership

| Shared root within an environment                                             | Vault                                                                                     |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Desktop settings, language, opening preference, device appearance preferences | Content/editor settings, selected spellcheck languages, custom words                      |
| Downloaded dictionaries                                                       | Database, notes, assets, backups, imports, restore records                                |
| Vault index and last-used startup preference                                  | Account session, sync state, credential identity                                          |
| Root transaction and coordinator records                                      | Lifetime ownership and vault recovery records                                             |
| Eventually global plugin packages, artifacts, presets, device plugin settings | Plugin enablement, accepted hashes/signers/grants, vault settings, writable `plugin-data` |

Account remains vault-specific. Mode and preset selection are independent. The
appearance follow-up moves accent and UI font size to device scope; editor font
size and line height remain vault preferences.

## Architecture checks and accepted platform risk

Run a two-day spike before committing to process-per-vault. Use disposable data
and record OS/build versions, commands, observations, and unresolved behavior.
Assumed platform behavior does not count as verification.

Progress: [Windows spike results and runnable probe](vault-runtime-spike.md)
confirm shared browser ownership/storage and separate-folder isolation, including
native popouts and worker restart. The [browser storage audit](vault-browser-storage-audit.md)
records the broader migration scope. On 2026-10-10 the owner accepted macOS 14+
and proceeding without an accessible Mac test machine. The packaged Dock/menu/
Reopen check is deferred to their next release test. This is accepted unverified
platform risk, not a successful macOS spike. Linux and supervised dev-host checks
remain required during implementation.

### macOS process and lifecycle spike

- Launch a packaged app with two workers and a coordinator. Check Dock icons,
  menu bars, Cmd + Q, Dock Reopen, hide/show, worker crashes, and focus.
- Verify worker activation policy, normal desktop windows, deterministic Reopen
  forwarding, signing, `.app` executable launches, and updater/shutdown behavior.
- If acceptable app identity and routing cannot be achieved, stop and revise the
  architecture before implementing Windows/Linux coordination. A single app
  host with vault contexts requires a separately estimated backend refactor.
  It is not an automatic fallback hidden in this plan.

### WebView stores and migration spike

- Default to a WebView data directory per vault and environment. Verify Tauri
  support on Windows/Linux and available macOS store isolation. Workers cannot
  rely on unsupported sharing of a WebKitGTK data directory.
- Check WebView2 browser-process ownership and `--renderer-process-limit=1`
  across simultaneous windows. Scope or revise the setting using measurements.
  Harness cleanup must not kill another worker's browser process.
- Decide legacy storage migration before concurrency: serialize legacy-store
  export/classification, or move vault-owned values to backend storage first.
  New workers cannot fall back silently to the shared legacy store.
- Audit every localStorage consumer, including `preferences.ts`, collaboration
  signing keys, hotkeys, dock/layout preferences, plugins, settings, and startup
  appearance. Classify root, vault, ephemeral, and credential state and define
  migration ownership. Preserve keys and existing values without copying
  unrelated vault/account state into new vaults.
- Verify restart and separation across vaults, dev/release origins, and test
  devices. Database-path isolation alone does not isolate browser state.

### Development launcher lifetime

The process owned by `tauri dev` must stay alive across worker handoffs and
closure. Prototype a long-lived host/coordinator that spawns workers. Verify
the CLI preserves Vite and sibling workers. Packaged/dev launch routing uses
explicit targets. Do not launch the coordinator as a disposable child of a
worker that exits on handoff, or retain the manual-restart workaround.

## Phase 0: independent data-safety fixes

Estimate: 2 to 3 working days. Implementation starts here before the spike.

Primary areas: `backup/restore.rs`, backup tests, `profiles.rs`,
`desktop_settings.rs`, `lib.rs`, and a shared atomic-file helper.

- Preserve committed WAL content before moving the live DB to its safety copy.
  Check checkpoint results, refuse unsafe preservation when another connection
  holds SQLite locks, and validate pending data before altering live files.
- Propagate restore failure to startup. Retain inputs and stop before opening
  an ambiguous or newly created database.
- Record repeatable restore steps so crashes after preserving the old database
  or installing the replacement can resume. Preserve ambiguous recovery state.
- Replace plain index/settings writes with same-folder temporary writes,
  flushing, and replace-without-delete publication. Corrupt/unreadable existing
  settings must not silently become defaults.
- Test real WAL commits, busy readers, replacement failures, and restore
  interruption boundaries. Byte-only DB fixtures do not prove content safety.
- Document limits: atomic replacement does not serialize read/modify/write;
  full vault ownership and concurrent merging follow below. Reboot durability
  needs platform flush tests beyond process termination.

Acceptance: safety DB contains WAL commits; ambiguous/failed restore stops boot
with inputs intact; replacement never deletes the old document first; invalid
settings remain intact.

Initial slice implemented on 2026-10-10: checkpointed safety copies, versioned
restore records with replacement hashes, startup error propagation, atomic index
and desktop-settings publication, and corrupt-settings errors. Regression tests
cover a terminated WAL writer, busy readers, interrupted move boundaries,
unexpected replacement WAL content, and concurrent document readers. Windows
`cargo test`, `cargo clippy -- -D warnings`, and `cargo fmt -- --check` pass.
Desktop settings move to the root in the Phase 1 slice below. macOS/Linux and
reboot durability checks are still pending.

## Phase 1: environments, ownership, and storage migration

Estimate: 3 to 4 working days. Proceed with the accepted macOS risk above.

Primary areas: paths/profiles/auth, launcher/config, WebView setup, frontend
persistence consumers, and all three WDIO real-app configs.

- Add release/dev/test identity independent of debug/optimized builds. Preserve
  production root and historical credential entries. Dev gets a persistent
  separate root and visible Dev identity; optionally namespace worktrees.
- Add gated root overrides for debug and `e2e-data-dir`. Isolate browser storage,
  credentials, logs, IPC/ports, and coordinator names. Harness restarts retain
  identity; simulated devices get separate identities. Disable dev/test updater,
  autostart, and global shortcuts by default; root names do not isolate those
  OS resources.
- Add lifetime OS vault locks using canonical physical vault identity across
  environments. Prevent lock-handle inheritance. File presence, PIDs, and
  heartbeat age are diagnostic only. Document that older binaries without
  ownership locks cannot be made safe by the new binary alone.
- Complete WebView migration and the full frontend scope audit. Root device
  state becomes backend-owned, with revisioned worker caches.
- Move desktop settings once: valid root values win; otherwise seed from the
  selected vault and journal completion. Never reseed on vault changes.
- Add locked root read/modify/write transactions, validation, previous-copy
  recovery, and explicit lock ordering/filesystem support.
- Recover interrupted legacy profile migration, including a moved root database
  whose index was never committed.
- Add dictionary locking before concurrent workers ship. Publish `.aff`/`.dic`
  together as a validated installation, recover interrupted operations, and
  invalidate resident dictionaries on remove/replace.

Acceptance: browser/environment isolation and credential migration pass;
duplicate physical-vault ownership is rejected; concurrent root edits preserve
both changes; concurrent dictionary operations are safe.

Phase 1 implementation slice on 2026-10-10:

- Explicit dev feature and bundle identity, stable dev root, gated test roots,
  per-root test credentials, isolated logs, and disabled dev/test autostart,
  updater and global shortcut registration. Release keyring entries retain
  their historical service and per-vault account names.
- Canonical vault OS locks acquired before restore/SQLite and retained until
  the database connection closes. Root locks serialize index mutations and
  individual revisioned desktop-settings edits. Existing lock files are reused.
- One-time desktop-settings migration from the selected vault. Valid root
  settings win; source files and unknown fields survive. Missing settings after
  the completion marker and corrupt documents require recovery.
- Journaled deletion blocks open vaults, removes the index entry, releases the
  in-directory lock before Windows deletion, and resumes interrupted deletion.
  Legacy migration resumes interrupted moves and rejects conflicting copies.
- All three real-app harnesses now set root overrides alongside their existing
  isolated WebView folders. macOS minimum is explicitly 14.0.

Windows validation for this slice: Rust fmt/clippy pass; serial full Rust suite
passes 731 unit tests and one integration test, with two existing ignored tests.
Focused frontend tests pass 35 checks; Svelte diagnostics and affected ESLint
files pass. The native app was launched through the dev wrapper with disposable
root/vault/browser folders. A duplicate launch refused ownership before SQLite,
a UI close-to-tray edit persisted root revision 1, and forced termination plus
restart reused the surviving lock file and retained the setting. Raw logs are
under `.output/ownership-app-check`. These are process-crash checks, not reboot
durability evidence. Serial Rust execution avoids the existing ts-rs export/read
race in generated-binding tests.

Shared dictionary slice on 2026-10-10: unique immutable `.aff`/`.dic`
generations publish through one atomic versioned manifest under a dictionary
operation lock. Network and validation run outside that lock. Legacy flat pairs
remain readable until replacement; removal tombstones override leftover flat
files. Readers and installed-list/WORDCHARS queries use the same ownership rule.
Resident caches check the published generation once per request. Corrupt or
missing referenced pairs are retained for recovery. Interrupted unpublished
generations are ignored, and old generations are retained pending bounded
cleanup. Concurrent pair readers, interrupted publication/removal, unsafe IDs,
missing/corrupt manifests, and two worker caches are tested. Windows Rust gates
pass 737 unit tests and one integration test, with two existing ignored tests.

Root recovery slice on 2026-10-10: index/settings saves preserve a validated
`.previous` copy under the root lock. Startup validates current documents first,
quarantines corrupt bytes before promoting a valid previous copy, and stops when
both copies are invalid. Index recovery checks referenced directories and pending
deletion records before selecting a vault. Missing selected directories cannot
be recreated as empty replacements. Missing indexes with multiple existing
vault directories require recovery. Desktop settings recover before restore or
SQLite mutation, and an invalid migration marker is preserved and refused.
Windows Rust gates pass 747 unit tests and one integration test, with two existing
ignored tests. Recovery selection UI and orphan-vault index salvage remain work
for the coordinator/picker. [Ownership and recovery rules](storage-ownership-and-recovery.md)
record lock ordering and filesystem limits.

Signing credential slice on 2026-10-10: collaboration identities are now owned
by a vault encrypted file with a separate vault key in the environment's OS
keystore. Native reads prefer the vault credential, then import only the matching
legacy browser account key without changing it. Sources are retained. Main and
note window create races return one persisted identity. Missing/locked keystore
keys, corrupt credentials and malformed legacy keys cannot silently generate a
replacement. Deleting a vault also attempts to remove its signing master key.
Windows fmt/clippy and the full Rust suite pass 753 unit tests and one integration
test. Three tests are ignored in the normal suite; the new Windows native keystore
test was run explicitly and passed with disposable entries. WebCrypto compatibility,
cryptographic scope binding and tamper rejection are tested. Affected frontend
checks pass, including 35 signing/frame/API tests. Legacy export for unopened
vaults still must preserve signing identities before isolated stores launch.

Schema-settings slice on 2026-10-10: native device settings live in root
`ui-settings.json`; content/account preferences live in vault
`content-settings.json`. The backend derives scope from the bundled schema,
keeps dynamic `hotkey.*` bindings at the root, and preserves unknown/plugin
entries with the vault. Existing documents win over browser migration inputs.
Only the default vault inherits content from the old unscoped bucket; another
vault requires its own bucket. Original browser bytes remain intact. Malformed
inputs stop migration before either candidate is published; completion records
prevent reseeding lost documents. Individual field edits reread under the root
lock, increment revisions and retain validated previous copies. Native caches
initialize before profile readiness, serialize writes, report failed saves, and
refresh on focus and same-worker popout events, including recovered older
revisions. Browser preview persistence remains unchanged. Cross-process
notifications still require the coordinator. Windows Rust gates pass 757 unit
tests and one integration test; three tests remain ignored. Focused frontend
settings/event/profile and hotkey checks pass 134 tests, with Svelte and affected
ESLint checks clean.

Native Windows verification for schema settings used disposable root/vault/
WebView folders through the dev wrapper. A UI edit saved Reduce motion to root
revision 1 and editor font size 18 to vault revision 1. After forced termination
and restart, the settings panel restored both values and the documents retained
their revisions. Logs are under `.output/ui-settings-app-check`. This verifies
process restart; it does not establish reboot durability.

Still pending in Phase 1: remaining legacy browser-store migration and root worker cache
broadcasts. Duplicate vault
launches currently refuse startup; focusing an existing owner requires Phase 2.

Toolbar/mobile device preference slice on 2026-10-11: file-tree toolbar order
and mobile list/grid preference use root fields with a one-time receipt. Unknown
plugin toolbar IDs and the old installation's default arrangement survive import.
Raw browser inputs are retained. Native saves patch one locked field; canonical
refresh and failed-write rollback update the rendered controls. Signature and
favourite source retention/assignment and full browser export remain pending.

Windows native verification used the existing disposable vault/root/browser
folders. Dragging "New note" ahead of "New folder" saved root revision 5 and
the toolbar retained that order after a WebView reload. Logs are under
`.output/toolbar-app-check`. Focused frontend checks pass 51 tests; Svelte
diagnostics are clean. Affected ESLint has no errors and reports the pre-existing
mobile `Set` warning.
Rust fmt/clippy and the serial full suite pass 766 unit tests and one integration
test; three tests remain ignored.

Legacy content slice on 2026-10-11: startup pins unscoped browser content to one
vault ID and canonical directory. Native signatures/favourites import only into
that owner and retain browser sources. A new local DB receipt commits with all
imported rows. Existing signature edits win; stable generated IDs and receipts
prevent replay after crashes or later deletions. Invalid JSON/geometry, conflicting
signature IDs and failed DB writes leave the receipt absent. Favourite imports
check write access, mark sync changes dirty, and patch only committed frontend
IDs. Tests exercise a simulated failure on the second DB insert, full rollback
and retry, malformed evidence, later deletion/unfavourite, and deleted owners.
Windows Rust fmt/clippy and the serial full suite pass 772 unit tests and one
integration test, with three ignored tests. Focused frontend checks pass 56 tests;
Svelte diagnostics are clean and affected ESLint has no errors.

Browser archive storage slice on 2026-10-11: root storage retains encrypted raw
WebView exports, with a separate OS-keystore migration key bound to environment
and canonical root. Captures are origin-specific and retain unopened accounts,
unknown plugin values and malformed bytes. Immutable per-origin completion
receipts prevent recapture after isolation. Atomic updates and recovery validate
checksums and every completed capture; missing keys, missing completed archives,
invalid receipts and incompatible previous copies require recovery. Key creation
before first publication, export-before-seal interruption and retries are tested.
The hidden export window and coordinator hookup remain pending; production
startup still uses its existing browser store.
Windows Rust fmt/clippy and the serial full suite pass 779 unit tests and one
integration test, with four ignored tests. The new real-keystore export test was
run explicitly and passed using disposable Windows Credential Manager entries.
Older binaries without locks remain unsafe against the same physical vault.

Mixed UI preferences slice on 2026-10-10: sidebar widths now use root document
fields; sorting and sidebar open/closed state use vault fields. Migration seeds
unscoped content preferences only into the selected legacy vault and records
completion at the root, retaining the browser source. Existing fields win and
malformed inputs/records refuse initialization. The schema's old device scope
for sort strategy is corrected; an existing root value moves to the selected
vault before source removal, and a recovered old root copy cannot leak sorting
into a different vault. Native sidebar/sort setters patch individual fields;
canonical snapshot refresh updates the live UI, and failures restore values and
show localized feedback. Browser preview behavior remains unchanged.

Windows validation for mixed preferences: Rust fmt/clippy and the full serial
suite pass 760 unit tests and one integration test, with three ignored tests.
Focused settings/preferences/state/profile/registry/hotkey checks pass 167
frontend tests. Svelte, affected ESLint, and localization checks pass. The native
dev app saved sort strategy and sidebar visibility to the vault while resizing
the right sidebar to 330 pixels updated the root. A WebView reload restored the
hidden left sidebar and shared width. Logs are under
`.output/preferences-app-check`; this is not a reboot durability check.

Dock-layout slice on 2026-10-10: saved notes/splits now use vault field
`ui.dockLayout`. Migration reads the matching encoded bucket; only the default
vault inherits the historical unscoped layout. Existing values win, malformed
required inputs stop publication, and source bytes remain intact. A vault
completion record plus explicit clear tombstone prevent old layouts from
reappearing. Native reads return a copy of the canonical snapshot, and writes
check the running vault ID and patch the content document. Windows Rust gates
pass 763 unit tests and one integration test, with three ignored tests. Focused
layout/settings/profile tests pass 49 frontend checks, and Svelte/affected ESLint
checks pass. Other browser consumers and full WebView export/isolation remain
pending.

Native dock-layout verification used the dev wrapper with disposable folders.
The legacy Welcome tab migrated into the vault document. Creating a second note
and dragging it into a split produced two saved groups and two panels. Reloading
the WebView restored both note panes from the canonical document. Logs are under
`.output/layout-app-check`; the original browser bucket remains retained.

## Phase 2: coordination and simultaneous vaults

Coordinator transport slice on 2026-10-11: `.coordinator.lock` grants ownership
through the OS only. Its owner publishes a private, versioned loopback endpoint
with a random authentication secret. Requests/replies are length-bounded and
correlated by operation/instance IDs, with whole-message deadlines and limited
incoming connections. Discovery retries preserve operation IDs; the runtime
dispatcher still must deduplicate mutations. Worker replies use separate
listeners and retain vault ownership. Shutdown holds the root coordinator lease
until accepted calls finish. Tests cover election races, independent roots,
authentication/version/size rejection, partial frames, live ownership during
shutdown, and force-terminating a real child process with stale records retained.
Unix endpoint files use owner-only mode; Windows inherits app-data ACLs. Runtime
worker registration, launch/focus routing and the supervised dev host are pending.
Windows Rust fmt/clippy and the serial full suite pass 788 unit tests and one
integration test, with five ignored tests including the coordinator subprocess
fixture. That fixture runs automatically through its parent crash test.

Startup contracts slice on 2026-10-11: explicit workers resolve an indexed vault
under the root lock without changing the last-used preference. Coordinators can
read/reconcile the index while workers hold vault ownership. Launch arguments
carry separate launch/coordinator identities; existing test devices retain direct
mode, while shared-root tests opt into supervision. Browser identities derive
from canonical root, vault ID and physical directory. Main/popout windows have a
native bridge for the same directory or macOS persistent store ID. This defines
the contracts; role selection and browser isolation are not activated in startup
until export and supervisor integration are complete.

This slice also fixes native popouts: all windows sharing a WebView2 environment
receive the main window's browser arguments. Tabs detach only after the SDK's
successful creation event. Seeded/imported note IDs receive the `note_*`
capability namespace and an explicit editor URL. The Windows native check opened
Welcome in a single-note popout, removed the source tab, then returned it with
Pop in and confirmed that only the main window remained. Disposable test logs
are in `.output/popout-browser-app-check-capability`. Rust fmt/clippy and the
full serial suite pass 793 unit tests and one integration test, with five ignored
tests. Seven focused frontend tests and Svelte checks pass. Affected ESLint has
no errors; the route retains its existing dynamic-component `any` warning.

Archive classification slice on 2026-10-11: a worker with a verified retained
source reads only its settings/layout bucket and matching server/username signing
key. Signature and favourite imports still check the physical legacy owner.
Unknown values remain in the encrypted archive. Backend initialization uses
these raw sources rather than a fresh worker's empty browser store. Version 2
of the root preference receipt records device migration separately from the
owner vault's content receipt, so opening another vault first cannot consume
sidebar/sort preferences. Existing version 1 receipts prevent reseeding. Native
signing import prefers an existing vault identity, then the matching retained
identity, then newly supplied material. Malformed candidates cannot create a
replacement identity. Rust gates pass 797 unit tests and one integration test;
five tests remain ignored. The supervisor still must load/register the verified
source before opening isolated workers.

Estimate: 5 to 7 working days, plus changes required by the spike.

Supervised startup slice on 2026-10-11: `--supervised-vaults` starts a long-lived
host without a vault database. A hidden legacy-origin document snapshots raw
localStorage before running any app code, retains it encrypted, and seals it
before workers can launch. Original browser values remain intact. A restart
between capture and sealing finishes the saved capture rather than exporting
changed bytes. Workers require an authorized launch identity, own their physical
vault before registering, load the verified migration source, and use isolated
WebView stores. Main windows remain hidden until native settings initialization
finishes. Repeated readiness reports do not reactivate old windows. Requests
deduplicate by operation ID and reserve one launch per vault. Filesystem or
spawn failure cannot leave a permanent starting reservation; an unknown worker
exit retains ownership rather than assuming the worker died.

The Windows native fixture opened Default and Second simultaneously with one
host and two workers, two browser directories and two vault databases. Reopening
Second reused its window. The host had no database. This verifies basic launch
and visibility, not Windows foreground permission, most-recent focus routing,
graceful editor shutdown or crash adoption. Logs remain in
`.output/supervised-startup-app-check`. The computer-use connection subsequently
failed with a missing native pipe, including after retry and kernel reset.
Normal startup stays direct until the remaining coordination gates pass. Root
hotkeys/tray/updater ownership, persisted worker registration and recovery,
cross-process settings events, macOS lifecycle, Linux activation and the handoff
UI remain required. Shared-root fixtures use only `MINDSTREAM_ROOT_DIR`; the
existing vault-directory override is rejected in supervised mode.
Rust fmt, clippy with warnings denied, and the full serial suite pass 801 unit
tests and one integration test, with five ignored tests. The affected frontend
checks pass 23 tests, including delayed/failed native settings readiness. Svelte
checks and affected ESLint pass without errors.

Keep one vault per worker for its lifetime. Use the validated long-lived
host/coordinator arrangement. Do not add in-process session swapping.

- Add protected local IPC, coordinator election, readiness registration,
  request IDs, bounded retries, and stale-registration reconciliation. Real
  locks determine ownership; unresponsive processes do not lose their locks.
  Avoid general root locks across IPC waits or network work.
- Launch explicit vault targets. Convert `profiles.json.active` to last-used
  startup preference, separate from live ownership.
- Implement normal launch, new-window requests, duplicates, and racing requests.
  Transfer Windows foreground permission with `AllowSetForegroundWindow` and
  propagate Wayland activation tokens where available. Verify menu, taskbar,
  Dock, and tray activation.
- Register worker main windows and note popouts labelled by note ID. Include
  them in focus, restoration, geometry, close-to-tray, and shutdown rules.
  Geometry is scoped by environment, vault, and window identity.
- Make root hotkey bindings authoritative. Migrate JS bindings; workers submit
  edits rather than registering globally. Tray/new-note actions target the most
  recent vault. With none open, launch the last-used vault and await readiness,
  or show a picker if unavailable. Define no-worker coordinator lifetime using
  tray/autostart preferences.
- Centralize tray and updates. Tray Quit flushes/closes this environment's
  workers. Update installation waits for workers, popouts, and services to stop.
- Broadcast device revisions and apply language/theme/decorations/tray changes.
  Recover coordinator crashes through election and worker re-registration.
- Deletion obtains exclusive vault ownership, journals/tombstones the vault,
  removes it from the index under the root lock, releases the in-directory
  lock handle, then deletes files on Windows. Tombstones and launch checks block
  reopening during deletion. Resume failures without reviving the index or
  deleting unrelated paths.

Acceptance: independent concurrent vaults, deterministic duplicate/focus
routing, correct popout lifecycle, one tray/shortcut owner, propagated device
changes, and recoverable deletion/shutdown.

## Phase 3: menu UI and worker handoff

Estimate: 4 to 6 working days including persistence/shutdown verification.

Primary areas: `VaultSwitcher.svelte`, profile APIs/stores, coordinator launch,
editor persistence, and secondary-window lifecycle.

- Add opening actions, remember checkbox, three-choice device preference,
  Ctrl + left click override, and accessible alternatives. Apply the same rules
  to newly created vaults; consider Command + click on macOS.
- Reserve/start the target as a prepared worker at source geometry. Ready means
  locks, recovery, settings, and account policy succeeded. Then flush main and
  popout editors and stop source services. Activation is a separate commit step.
  Cancel the prepared target when source persistence cannot finish.
- Keep the source alive on target failure, cancellation, or failed flush. Handle
  crashes/lost acknowledgements with operation IDs and repeatable handoff state.
  Target preparation cannot perform source-session-derived writes.
- Focus an existing target without closing the source, including Ctrl + click.
  Suppress repeated requests during handoff.
- Remove desktop global-active/relaunch/manual-restart switching. Retain browser
  fallback and mobile restart compatibility. Dev's supervised host stays alive.

Acceptance: handoff keeps geometry/content, failure leaves a usable source,
new-window leaves it running, preference/Ctrl + click work, and no backend
session swap or `State<Db>` refactor is required.

## Phase 4: recovery, platform checks, and documentation

Estimate: 3 to 4 working days. Add focused tests with each earlier change.

- Test shared-root/different-vault workers separately from isolated devices
  sharing a remote account. Preserve both existing multiremote suites.
- Race launches/root edits; test hung owners, PID reuse, crash-released locks,
  missing/corrupt documents, and last-used fallback. Keep ownership rules enabled
  in tests.
- Interrupt restore/migration/deletion/dictionary publication at every phase;
  reopen repeatedly. Use VM/reboot tests for durability. Never sweep DB WAL files.
- Startup routes launch, recovers locked root operations, acquires vault
  ownership, reconciles restore, lets SQLite recover, checks schema/unclean
  integrity, then registers ready and starts services. Preserve dirty rows and
  tombstones during recovery.
- Verify foreground grants, Wayland activation, macOS app identity/Reopen,
  `tauri dev`, popouts, tray, and multi-window shutdown.
- Harness cleanup tracks only its root's host/workers/browser processes and
  waits for lock release before restart. Add isolation preflight checks and
  readiness/focus failure artifacts.
- Run required Rust gates and affected frontend/real-app checks. Update build,
  architecture, recovery, storage-scope, and harness documentation.

## Estimate and delivery

Core work is roughly 19 to 26 working days including the spike and safety slice,
about four to six weeks. The original combined scope with plugins/themes needs
five to seven weeks or more if the spike rejects process-per-vault. These are
planning ranges; platform constraints remain to be tested.

Ship safety fixes independently, then spike findings and an explicit architecture
decision, environments/ownership, coordination, and UI handoff. Keep migrations
and recovery tests in the same reviewable change. Commit automatically after
required checks using scoped Conventional Commit messages.

Out of scope: exact native-window preservation through backend session swapping,
multiple local writers, full previous-session reopening, network-filesystem
vaults, full settings/plugin-data backup portability, and the separate plugins
and themes projects.
