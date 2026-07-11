/**
 * T4 — collection sharing (manifest bundles), docs/e2e-flows.md §4 and
 * e2e-strategy.md §5. Every flow here is Etebase network IO with no unit
 * coverage, and the meaningful ones need **two distinct accounts** — a sender
 * (A) and a recipient (B) whose public key A resolves via `fetch_user_profile`.
 * That is a stronger requirement than the collab.e2e.ts matrix (one account,
 * two devices): these must provision two real users on the same backend.
 *
 * Like collab.e2e.ts this is gated to skip until the two-client seam runs (wdio
 * multiremote → `browserA`/`browserB`, two driver processes) plus two-account
 * provisioning against Etebase (e2e-strategy.md §2.1, §7).
 *
 * Status: flows 4.1–4.4 are IMPLEMENTED against confirmed accessible names and
 * the per-client `clientHelpers` factory (harness.ts) — not yet validated on a
 * live two-app + backend session. 4.5–4.10 stay documented skeletons: each needs
 * a seam that doesn't exist yet — server-side part-invite cancellation (4.5), a
 * lone non-manifest invite path (4.6), move-UI automation + asset embedding
 * (4.7/4.7b), and an offline/network toggle hook (4.8–4.10).
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

import { expect } from '@wdio/globals';

import { provisionTwoAccounts, type TwoAccounts } from '../helpers/accounts.js';
import { assertBackendReady, backendUrl } from '../helpers/backend.js';
import {
  clientHelpers,
  loginClient,
  requireBackendE2E,
  type ClientHelpers
} from '../helpers/harness.js';

// wdio multiremote exposes each capability key as a global browser instance.
// `browserA` = sender (device A), `browserB` = recipient (device B). See
// e2e/app/wdio.multiremote.conf.ts.
declare const browserA: WebdriverIO.Browser;
declare const browserB: WebdriverIO.Browser;

describe('T4 collection sharing (manifest bundles)', function () {
  // The two distinct accounts this whole suite hinges on — provisioned once,
  // then each client is signed into one of them. `sender` shares; `recipient`
  // receives. Available to every spec body below.
  let accounts: TwoAccounts;

  // Per-client helpers bound to a single browser. The global `aria/` helpers in
  // harness.ts fan out to BOTH browsers under multiremote, so every seed/click
  // in the bodies below goes through `A` (sender) or `B` (recipient).
  let A: ClientHelpers;
  let B: ClientHelpers;

  before(async function () {
    requireBackendE2E(this);
    await assertBackendReady();
    const server = backendUrl();

    // Two real Etebase signups (not a shared-collection trick) so the sender
    // can resolve the recipient's pubkey via fetch_user_profile. Requires the
    // test stack's AUTO_SIGNUP=true (pnpm backend:test:up).
    accounts = await provisionTwoAccounts(server);

    // Sign each client into its own account through the Account UI (no global
    // Tauri IPC available in the WebView).
    await loginClient(browserA, {
      serverUrl: server,
      username: accounts.sender.username,
      password: accounts.sender.password
    });
    await loginClient(browserB, {
      serverUrl: server,
      username: accounts.recipient.username,
      password: accounts.recipient.password
    });

    A = clientHelpers(browserA);
    B = clientHelpers(browserB);
  });

  // The folder A seeds in 4.1 and shares to B; later flows assume it exists.
  const SHARED_FOLDER = 'Shared Project';
  const SHARED_NOTE = 'Kickoff';

  // --- 4.1 Outgoing share creation (P1) ---
  it('A shares a folder → invite succeeds and folder flags shared-by-me', async () => {
    // Seed a folder with a note on A via the validated draft-input flow
    // (toolbar "New folder" → inline draft; folder context menu "New note in
    // folder" → inline draft). See e2e/browser/tree-operations.spec.ts.
    await A.newRootFolder(SHARED_FOLDER);
    await A.newNoteInFolder(SHARED_FOLDER, SHARED_NOTE);

    // Right-click the folder → "Share folder…" opens the dialog.
    await A.clickElement(A.treeItem(SHARED_FOLDER), { button: 'right' });
    await A.clickMenuItem('Share folder…');

    // Fill "User" with B's real username, pick "Can edit", then "Invite".
    await A.setValue('User', accounts.recipient.username);
    await A.click('Permission');
    await A.click('Can edit');
    await A.click('Invite');

    // Success: the dialog closes and the folder now carries the shared-by-me
    // badge — a Share2 icon whose accessible name is "Shared" (nav.shared),
    // rendered inside the folder's tree row (FileExplorer.svelte).
    await expect(A.treeItem(SHARED_FOLDER).$('aria/Shared')).toBeDisplayed();

    // Negative: an UNKNOWN username must fail at the pubkey lookup, BEFORE any
    // scope collections are created.
    await A.clickElement(A.treeItem(SHARED_FOLDER), { button: 'right' });
    await A.clickMenuItem('Share folder…');
    await A.setValue('User', `nobody-${Date.now()}`);
    await A.click('Invite');
    // fetch_user_profile can't resolve the pubkey → the dialog surfaces an
    // error and stays open (Invite still present). It must NOT silently create
    // scope collections.
    await expect(A.byName('Invite')).toBeDisplayed();
    await A.click('Cancel');
  });

  // Before accept the bundle name is unknown, so the widget shows the generic
  // "wants to share" pending title (ShareBundleNotificationWidget.svelte).
  const pendingBundleTitle = () =>
    `${accounts.sender.username} wants to share a folder with you`;
  // A lone non-manifest collection invite would surface as this legacy title
  // instead — its presence here would mean the raw part-invites leaked.
  const legacyInviteTitle = () => `${accounts.sender.username} invited you`;

  // --- 4.2 Incoming share shows as one bundle, not N invites (P1) ---
  it('B sees exactly one share-bundle notification, not four raw invites', async () => {
    // Opening the center triggers scanForCollectionInviteNotifications, which
    // collapses the manifest/folders/notes/assets part-invites into one bundle.
    await B.openNotifications();

    // Exactly one bundle entry, shown as the pending "wants to share" title...
    await expect(B.byName(pendingBundleTitle())).toBeDisplayed();
    await expect(B.allByName(pendingBundleTitle())).toBeElementsArrayOfSize(1);

    // ...and NONE of the referenced part-invites leaked as legacy collaboration
    // invites (they're hidden from the raw invite list).
    await expect(B.allByName(legacyInviteTitle())).toBeElementsArrayOfSize(0);
  });

  // --- 4.3 Accept a share bundle (P1) ---
  it('B accepts the bundle → shared root lands under "Shared", not Home', async () => {
    // Accept the (only) bundle → the notification dismisses and a scoped sync
    // pulls the shared root in.
    await B.click('Accept');
    await expect(B.byName(pendingBundleTitle())).not.toBeDisplayed();

    // The shared root lands under the "Shared" source, NOT Home. Switch to the
    // "Shared" chip and assert the folder (and its seeded note) appear there.
    await B.click('Shared');
    await expect(B.treeItem(SHARED_FOLDER)).toBeDisplayed();
    await expect(B.treeItem(SHARED_NOTE)).toBeDisplayed();

    // Regression guard: the shared root must NOT show up in Home (that would
    // mean the "Shared" projection didn't run — shared_role/share_id unset).
    await B.click('Home');
    await expect(B.treeItem(SHARED_FOLDER)).not.toBeDisplayed();
  });

  const SECOND_FOLDER = 'Second Share';

  // --- 4.4 Decline a share bundle (P2) ---
  it('B declines a second bundle → it does not loop back on rescan', async () => {
    // A seeds and shares a SECOND folder to B.
    await A.newRootFolder(SECOND_FOLDER);
    await A.clickElement(A.treeItem(SECOND_FOLDER), { button: 'right' });
    await A.clickMenuItem('Share folder…');
    await A.setValue('User', accounts.recipient.username);
    await A.click('Permission');
    await A.click('Can edit');
    await A.click('Invite');

    // B sees the (pending) bundle and declines it.
    await B.openNotifications();
    await expect(B.byName(pendingBundleTitle())).toBeDisplayed();
    await B.click('Decline');
    await expect(B.byName(pendingBundleTitle())).not.toBeDisplayed();

    // No shared folder is added under "Shared".
    await B.click('Shared');
    await expect(B.treeItem(SECOND_FOLDER)).not.toBeDisplayed();

    // Regression guard: a rescan (reopening the center re-lists manifest
    // collections) must NOT resurrect the declined bundle. Decline leaves the
    // auto-accepted manifest collection behind precisely so it can't reappear.
    await B.openNotifications();
    await expect(B.byName(pendingBundleTitle())).not.toBeDisplayed();
  });

  // --- 4.5 Incomplete bundle can't be accepted (P2) ---
  it('an incomplete bundle disables Accept and shows the incomplete warning', async function () {
    // Construct a share missing one required part invite (e.g. cancel the
    // assets invite server-side after creation). Assert B's bundle notification
    // shows the incomplete message (ui.notifications.shareBundle.incomplete),
    // Accept is disabled, and Decline stays available.
    this.skip();
  });

  // --- 4.6 Non-manifest invitation still surfaces (P3) ---
  it('a lone non-manifest collection invite shows as a legacy collaboration-invite', async function () {
    // Invite B directly to a lone collection whose type isn't part of a
    // manifest scope. Assert it shows as a single collaboration-invite
    // notification ("{A} invited you"), independent of the bundle path.
    this.skip();
  });

  // --- 4.7 Shared subtree content converges (P1) ---
  // NOTE: the create/move half of this flow is now unblocked — scope
  // inheritance on create + re-home on move landed on this branch, so a note
  // ADDED to the shared folder after the share should converge WITHOUT a
  // re-invite. Assert exactly that (no longer "known follow-up").
  it('shared notes + assets converge, and post-share additions inherit the scope', async function () {
    // A shares a folder containing notes + an embedded image → B accepts → after
    // a sync B sees the notes and the asset RENDERS (no "partial media
    // unavailable"). Then A ADDS a note (and a sub-folder + note) inside the
    // shared folder — WITHOUT re-inviting — and MOVES an existing vault note
    // into it. B pulls → assert all of them appear (scope inheritance on
    // create + re-home on move). If B has read-write, an edit in B converges
    // back to A. Watch for: the shared root arriving under B's tree root via
    // orphan-reparent; a read-only recipient's local edit looping as a failed
    // scope push.
    this.skip();
  });

  // --- 4.7b Move out of a shared folder re-homes back to the vault (P2) ---
  it('moving a note out of the shared folder removes it from the recipient', async function () {
    // Complements the create/move fix from the other direction: A moves a note
    // OUT of the shared folder into a personal (vault) folder. Assert B no
    // longer sees it after a sync (the row was re-homed out of the scope: its
    // scope copy tombstoned, re-created in the vault). Moving the share ROOT
    // itself within the vault must KEEP its scope (share-anchor guard).
    this.skip();
  });

  // --- 4.8 Offline note edit survives a re-home (P1) ---
  it("A's offline note edit is merged into the scope, no orphan vault copy", async function () {
    // Owner signed in on A and B, both holding folder F. Take A OFFLINE and edit
    // a note in F (leave it unpushed, dirty=1). On B, "Share folder…" F with a
    // second account (re-homes F into a scope). Bring A back ONLINE and sync.
    // Assert: A's edit is MERGED into the scope copy (CRDT body merge), F ends
    // up in the scope on A, and NO orphan vault copy is left on the server
    // (which would flip-flop the note between vault and scope). Watch for a
    // duplicate note on any device (orphan resurrection).
    this.skip();
  });

  // --- 4.9 Offline folder rename survives a re-home (P2) ---
  it("A's offline folder rename survives the re-home (no LWW clobber)", async function () {
    // Owner on A + B, both holding F. A OFFLINE, rename F (or a subfolder). B
    // SHARES F. A back ONLINE, sync. Assert A's offline rename is KEPT (not
    // reverted to the remote name), stays dirty, and pushes into the scope.
    // Also cover a folder MOVED to root offline in the same window: it must not
    // get reattached under its old parent by the repair pass.
    this.skip();
  });

  // --- 4.10 Edit-wins-over-delete conflict (P2) ---
  it('a locally edited note resurrects over a remote delete (edit wins)', async function () {
    // Owner on A + B, same PLAIN vault note N (not shared). A OFFLINE, edit N
    // (unpushed). On B, delete N and let it sync. Bring A ONLINE. Assert N is
    // RESURRECTED with A's edit and reappears on B after B's next pull. A clean
    // (unedited) note deleted on B stays deleted on A (control case). Note:
    // signatures are intentionally NOT covered by edit-wins — they hard-delete
    // on a tombstone.
    this.skip();
  });
});
