/**
 * T4 — collection sharing (manifest bundles), docs/e2e-flows.md §4 and
 * e2e-strategy.md §5. Every flow here is Etebase network IO with no unit
 * coverage, and the meaningful ones need **two distinct accounts** — a sender
 * (A) and a recipient (B) whose public key A resolves via `fetch_user_profile`.
 * That is a stronger requirement than the collab.e2e.ts matrix (one account,
 * two devices): these must provision two real users on the same backend.
 *
 * Like collab.e2e.ts this is the faithful scenario skeleton. It is gated to
 * skip until the two-client seam lands (wdio multiremote → `browserA`/`browserB`
 * or two driver processes) plus two-account provisioning against Etebase
 * (e2e-strategy.md §2.1, §7). The bodies document exactly what each real spec
 * must drive and assert so they can be filled in against that harness without
 * re-deriving the flow.
 *
 * Accessible names referenced below (from src/lib/settings/i18n/en.json, the
 * same names the SvelteKit UI renders inside the WebView):
 *   - folder context menu:      "Share folder…"     (ui.sharing.menu.shareFolder)
 *   - share dialog user field:  "User"              (ui.sharing.dialog.userLabel)
 *   - share dialog permission:  "Permission"        (ui.sharing.dialog.permissionLabel)
 *   - permission options:       "Can view" / "Can edit" / "Admin"
 *   - share dialog submit:      "Invite"            (ui.sharing.dialog.invite)
 *   - bundle notification:      "{sender} shared “{name}”"  / pending variant
 *   - bundle actions:           "Accept" / "Decline"
 *   - shared tree section:      "Shared"            (ui.nav.shared)
 *   - view-only editor banner:  ui.editor.viewonly.banner
 */

import { assertBackendReady, backendUrl } from '../helpers/backend.js';
import { requireBackendE2E } from '../helpers/harness.js';

describe('T4 collection sharing (manifest bundles)', function () {
  before(async function () {
    requireBackendE2E(this);
    await assertBackendReady();
    // TODO(two-account harness): provision two distinct Etebase users on the
    // same backend and sign each app (two profile dirs) into one of them.
    // Prefer seeding a pre-authenticated session blob + the server URL into
    // each profile dir over driving the Account UI each run (§3). Expose the
    // two sessions as `browserA` (sender) and `browserB` (recipient) via wdio
    // multiremote. `fetch_user_profile` must be able to resolve B's pubkey from
    // A, so both accounts must be real signups, not a shared-collection trick.
    void backendUrl;
  });

  // --- 4.1 Outgoing share creation (P1) ---
  it('A shares a folder → invite succeeds and folder flags shared-by-me', async () => {
    // A: seed a folder with a note → right-click it → "Share folder…" →
    // fill "User" with B's username → pick a "Permission" → "Invite".
    // Assert: the dialog shows no error and the folder now renders shared-by-me
    // in A's tree (the shared badge). Also assert an UNKNOWN username fails
    // BEFORE any scope collections are created — pubkey lookup is first.
    // TODO: multiremote + two accounts.
  });

  // --- 4.2 Incoming share shows as one bundle, not N invites (P1) ---
  it('B sees exactly one share-bundle notification, not four raw invites', async () => {
    // After 4.1, B opens Notifications. Assert exactly one bundle entry titled
    // "{A} shared “{folder}”" (pending variant before accept) — NOT separate
    // manifest/folders/notes/assets invites. The referenced part invites are
    // hidden from the raw invite list. TODO.
  });

  // --- 4.3 Accept a share bundle (P1) ---
  it('B accepts the bundle → shared root lands under "Shared", not Home', async () => {
    // B accepts the bundle → the notification clears. After a scoped sync the
    // shared root folder appears under the "Shared" section (shared_role +
    // share_id set), NOT in Home. A rescan must NOT resurrect the bundle.
    // Watch for: root in Home with no shared_role/share_id (projection didn't
    // run); a read-only recipient whose contents stay empty after first sync.
    // TODO.
  });

  // --- 4.4 Decline a share bundle (P2) ---
  it('B declines a second bundle → it does not loop back on rescan', async () => {
    // A sends a second share to B → B declines. Assert the notification clears,
    // no shared folder is added, and a rescan (which re-lists manifest
    // collections) does NOT bring the bundle back — the regression guard that
    // decline leaves the auto-accepted manifest collection so it can't reappear.
    // TODO.
  });

  // --- 4.5 Incomplete bundle can't be accepted (P2) ---
  it('an incomplete bundle disables Accept and shows the incomplete warning', async () => {
    // Construct a share missing one required part invite (e.g. cancel the
    // assets invite server-side after creation). Assert B's bundle notification
    // shows the incomplete message (ui.notifications.shareBundle.incomplete),
    // Accept is disabled, and Decline stays available. TODO.
  });

  // --- 4.6 Non-manifest invitation still surfaces (P3) ---
  it('a lone non-manifest collection invite shows as a legacy collaboration-invite', async () => {
    // Invite B directly to a lone collection whose type isn't part of a
    // manifest scope. Assert it shows as a single collaboration-invite
    // notification ("{A} invited you"), independent of the bundle path. TODO.
  });

  // --- 4.7 Shared subtree content converges (P1) ---
  // NOTE: the create/move half of this flow is now unblocked — scope
  // inheritance on create + re-home on move landed on this branch, so a note
  // ADDED to the shared folder after the share should converge WITHOUT a
  // re-invite. Assert exactly that (no longer "known follow-up").
  it('shared notes + assets converge, and post-share additions inherit the scope', async () => {
    // A shares a folder containing notes + an embedded image → B accepts → after
    // a sync B sees the notes and the asset RENDERS (no "partial media
    // unavailable"). Then A ADDS a note (and a sub-folder + note) inside the
    // shared folder — WITHOUT re-inviting — and MOVES an existing vault note
    // into it. B pulls → assert all of them appear (scope inheritance on
    // create + re-home on move). If B has read-write, an edit in B converges
    // back to A. Watch for: the shared root arriving under B's tree root via
    // orphan-reparent; a read-only recipient's local edit looping as a failed
    // scope push. TODO.
  });

  // --- 4.7b Move out of a shared folder re-homes back to the vault (P2) ---
  it('moving a note out of the shared folder removes it from the recipient', async () => {
    // Complements the create/move fix from the other direction: A moves a note
    // OUT of the shared folder into a personal (vault) folder. Assert B no
    // longer sees it after a sync (the row was re-homed out of the scope: its
    // scope copy tombstoned, re-created in the vault). Moving the share ROOT
    // itself within the vault must KEEP its scope (share-anchor guard). TODO.
  });

  // --- 4.8 Offline note edit survives a re-home (P1) ---
  it("A's offline note edit is merged into the scope, no orphan vault copy", async () => {
    // Owner signed in on A and B, both holding folder F. Take A OFFLINE and edit
    // a note in F (leave it unpushed, dirty=1). On B, "Share folder…" F with a
    // second account (re-homes F into a scope). Bring A back ONLINE and sync.
    // Assert: A's edit is MERGED into the scope copy (CRDT body merge), F ends
    // up in the scope on A, and NO orphan vault copy is left on the server
    // (which would flip-flop the note between vault and scope). Watch for a
    // duplicate note on any device (orphan resurrection). TODO.
  });

  // --- 4.9 Offline folder rename survives a re-home (P2) ---
  it("A's offline folder rename survives the re-home (no LWW clobber)", async () => {
    // Owner on A + B, both holding F. A OFFLINE, rename F (or a subfolder). B
    // SHARES F. A back ONLINE, sync. Assert A's offline rename is KEPT (not
    // reverted to the remote name), stays dirty, and pushes into the scope.
    // Also cover a folder MOVED to root offline in the same window: it must not
    // get reattached under its old parent by the repair pass. TODO.
  });

  // --- 4.10 Edit-wins-over-delete conflict (P2) ---
  it('a locally edited note resurrects over a remote delete (edit wins)', async () => {
    // Owner on A + B, same PLAIN vault note N (not shared). A OFFLINE, edit N
    // (unpushed). On B, delete N and let it sync. Bring A ONLINE. Assert N is
    // RESURRECTED with A's edit and reappears on B after B's next pull. A clean
    // (unedited) note deleted on B stays deleted on A (control case). Note:
    // signatures are intentionally NOT covered by edit-wins — they hard-delete
    // on a tombstone. TODO.
  });
});
