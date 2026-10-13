/**
 * T4 — sharing a folder, docs/e2e/flows.md §4.
 * Every flow here is network IO against the sync server with no unit
 * coverage, and the meaningful ones need **two distinct accounts** — a sender
 * (A) and a recipient (B) whose public key A resolves via `fetch_user_profile`.
 * That is a stronger requirement than the collab.e2e.ts matrix (one account,
 * two devices): these must provision two real users on the same backend.
 *
 * A shared folder is one collection on the server, so sharing is one
 * invitation. There is no state in which B holds part of a share, which is
 * why the old flow 4.5 (a share that arrived in part) has no successor here.
 *
 * Status: flows 4.1–4.4, 4.6, the core 4.7 subtree convergence path,
 * 4.7b move-out re-home, 4.11 joining by an invite link and 4.12 keys that
 * changed are IMPLEMENTED and validated against the live two-app + backend
 * session. The
 * owner-second-device 4.8–4.9 re-home cases live in
 * sharing-multi-device.e2e.ts because they require A1 + A2 + recipient B.
 * Plain-vault 4.10 lives in sync-history.e2e.ts.
 *
 * Accessible names referenced below (from src/lib/settings/i18n/en.json, the
 * same names the SvelteKit UI renders inside the WebView):
 *   - folder context menu:      "Sharing" ▸ "Share folder…"
 *                               (ui.sharing.menu.group ▸ ui.sharing.menu.shareFolder)
 *   - share dialog user field:  "Users"             (ui.sharing.dialog.userLabel;
 *                               plural since the dialog took comma-separated lists)
 *   - share dialog permission:  "Permission"        (ui.sharing.dialog.permissionLabel)
 *   - permission options:       "Can view" / "Can edit" / "Admin"
 *   - share dialog submit:      "Invite"            (ui.sharing.dialog.invite)
 *   - share notification:       "{sender} shared “{name}” with you"
 *                               (ui.notifications.shareInvite.title)
 *   - share actions:            "Accept" / "Decline"
 *   - shared tree section:      "Shared"            (ui.nav.shared)
 *   - share dialog, to links:   "Invite with a link" (ui.sharing.dialog.toLinks)
 *   - links section:            "Create link"       (ui.sharing.links.create)
 *   - tree background menu:     "Join shared folder…" (ui.sharing.menu.joinByLink)
 *   - join dialog:              "Invite link" / "Continue" / "Join"
 *                               (ui.sharing.join.*)
 *   - changed key, sending:     "Share with the new key"
 *                               (ui.sharing.key.trustAndInvite)
 *   - changed key, receiving:   "Accept anyway"
 *                               (ui.notifications.invite.acceptAnyway)
 *   - view-only editor banner:  ui.editor.viewonly.banner
 */

import { expect } from '@wdio/globals';

import {
  provisionTwoAccounts,
  type TwoAccounts
} from '../../helpers/accounts.js';
import { backendUrl } from '../../helpers/backend.js';
import {
  clientHelpers,
  loginClient,
  syncClient,
  waitForClientsReady,
  type ClientHelpers
} from '../../helpers/harness.js';

// wdio multiremote exposes each capability key as a global browser instance.
// `browserA` = sender (device A), `browserB` = recipient (device B). See
// e2e-tests/app/wdio.multiremote.conf.ts.
declare const browserA: WebdriverIO.Browser;
declare const browserB: WebdriverIO.Browser;

async function setSharePermission(
  client: WebdriverIO.Browser,
  optionLabel: string
): Promise<void> {
  await client.execute((label: string) => {
    const field = Array.from(document.querySelectorAll('label')).find(
      (candidate) => candidate.textContent?.includes('Permission')
    );
    const select = field?.querySelector('select');
    if (!select) throw new Error('share permission select not found');
    const option = Array.from(select.options).find(
      (candidate) => candidate.textContent?.trim() === label
    );
    if (!option) throw new Error(`share permission option not found: ${label}`);
    select.value = option.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, optionLabel);
}

async function submitShareInvite(client: WebdriverIO.Browser): Promise<void> {
  await client.waitUntil(
    () =>
      client.execute(() => {
        const dialog = document.querySelector<HTMLElement>(
          '[role="dialog"][aria-labelledby="share-collection-title"]'
        );
        const button = Array.from(
          dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []
        ).find((candidate) => candidate.textContent?.trim() === 'Invite');
        return button !== undefined && !button.disabled;
      }),
    {
      timeout: 30_000,
      timeoutMsg: 'share invite button did not enable'
    }
  );

  await client.execute(() => {
    const dialog = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-labelledby="share-collection-title"]'
    );
    const button = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []
    ).find((candidate) => candidate.textContent?.trim() === 'Invite');
    if (!button) throw new Error('share invite button not found');
    button.click();
  });
}

async function expectSharedByMeBadge(
  client: WebdriverIO.Browser,
  folder: string
): Promise<void> {
  await client.waitUntil(
    () =>
      client.execute((folderName: string) => {
        const row = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-file-tree-node]')
        ).find((candidate) => candidate.textContent?.includes(folderName));
        return row?.querySelector('svg[aria-label="Shared"]') !== null;
      }, folder),
    {
      timeout: 180_000,
      timeoutMsg: `shared-by-me badge did not appear for ${folder}`
    }
  );
}

async function selectTreeSource(
  client: WebdriverIO.Browser,
  label: 'Home' | 'Shared'
): Promise<void> {
  await client.execute((sourceLabel: string) => {
    const nav = document.querySelector<HTMLElement>(
      'nav[aria-label="Primary"]'
    );
    const button = nav?.querySelector<HTMLButtonElement>(
      `button[aria-label="${sourceLabel}"]`
    );
    if (!button) throw new Error(`source chip not found: ${sourceLabel}`);
    button.click();
  }, label);
}

/** Click a button by its text inside one dialog, once it can be clicked. */
async function clickDialogButton(
  client: WebdriverIO.Browser,
  labelledBy: string,
  text: string
): Promise<void> {
  await client.waitUntil(
    () =>
      client.execute(
        (dialogId: string, label: string) => {
          const dialog = document.querySelector<HTMLElement>(
            `[role="dialog"][aria-labelledby="${dialogId}"]`
          );
          const button = Array.from(
            dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []
          ).find((candidate) => candidate.textContent?.trim() === label);
          return button !== undefined && !button.disabled;
        },
        labelledBy,
        text
      ),
    {
      timeout: 30_000,
      timeoutMsg: `"${text}" did not become clickable in ${labelledBy}`
    }
  );
  await client.execute(
    (dialogId: string, label: string) => {
      const dialog = document.querySelector<HTMLElement>(
        `[role="dialog"][aria-labelledby="${dialogId}"]`
      );
      const button = Array.from(
        dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []
      ).find((candidate) => candidate.textContent?.trim() === label);
      if (!button) throw new Error(`button not found: ${label}`);
      button.click();
    },
    labelledBy,
    text
  );
}

/** Close whichever sharing dialog is open, if one is. */
async function closeSharingDialogs(client: WebdriverIO.Browser): Promise<void> {
  await client.execute(() => {
    for (const id of [
      'share-collection-title',
      'manage-access-title',
      'join-link-title'
    ]) {
      document
        .querySelector<HTMLButtonElement>(
          `[role="dialog"][aria-labelledby="${id}"] button[aria-label="Close"]`
        )
        ?.click();
    }
  });
}

/** Open the menu of the file tree's background, as a right-click on the
 *  empty part of the tree does. */
async function openTreeBackgroundMenu(
  client: WebdriverIO.Browser
): Promise<void> {
  await client.execute(() => {
    const tree = document.querySelector<HTMLElement>(
      '[role="group"][aria-label="File tree"]'
    );
    if (!tree) throw new Error('file tree not found');
    const rect = tree.getBoundingClientRect();
    tree.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.bottom - 8,
        button: 2,
        buttons: 2
      })
    );
  });
}

interface CollectionRow {
  id: string;
  name: string;
  parent_collection_id: string | null;
  share_id?: string | null;
  shared_role?: string | null;
}

interface ShareLinkRow {
  uid: string;
  access_level: string;
  max_uses: number;
  uses: number;
}

interface MemberRow {
  username: string;
  access_level: string;
}

interface UserKeyRow {
  username: string;
  standing: 'new' | 'known' | 'changed';
  fingerprint: string;
  known_fingerprint: string | null;
}

/** Call a command that is expected to be refused, and say with which
 *  reason. `null` when it went through. */
async function refusalOf(
  client: WebdriverIO.Browser,
  command: string,
  args?: Record<string, unknown>
): Promise<string | null> {
  return client.execute(
    async (cmd: string, invokeArgs: Record<string, unknown> | undefined) => {
      const tauri = window as unknown as {
        __TAURI_INTERNALS__?: {
          invoke?: (
            command: string,
            args?: Record<string, unknown>
          ) => Promise<unknown>;
        };
      };
      const invoke = tauri.__TAURI_INTERNALS__?.invoke;
      if (!invoke) throw new Error('Tauri invoke is not exposed in WebView');
      try {
        await invoke(cmd, invokeArgs);
        return null;
      } catch (err) {
        const reason = (err as { reason?: unknown } | null)?.reason;
        return typeof reason === 'string' ? reason : `not a refusal: ${err}`;
      }
    },
    command,
    args
  );
}

interface NoteRow {
  id: string;
  title: string;
  body?: string;
  parent_collection_id: string | null;
}

interface AssetRow {
  id: string;
  bytes: number[];
}

interface IncomingShareFixture {
  invitation_id: string;
  collection_uid: string;
  name: string | null;
  sender_username: string | null;
  access_level: string;
}

async function invokeTauri<T>(
  client: WebdriverIO.Browser,
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  return client.execute(
    async (cmd: string, invokeArgs: Record<string, unknown> | undefined) => {
      const tauri = window as unknown as {
        __TAURI_INTERNALS__?: {
          invoke?: <R>(
            command: string,
            args?: Record<string, unknown>
          ) => Promise<R>;
        };
      };
      const invoke = tauri.__TAURI_INTERNALS__?.invoke;
      if (!invoke) throw new Error('Tauri invoke is not exposed in WebView');
      return invoke(cmd, invokeArgs);
    },
    command,
    args
  ) as Promise<T>;
}

async function listCollections(
  client: WebdriverIO.Browser
): Promise<CollectionRow[]> {
  return invokeTauri<CollectionRow[]>(client, 'list_collections');
}

async function findCollectionId(
  client: WebdriverIO.Browser,
  name: string
): Promise<string> {
  const collections = await listCollections(client);
  const collection = collections.find((candidate) => candidate.name === name);
  if (!collection) throw new Error(`collection not found: ${name}`);
  return collection.id;
}

async function createCollectionFixture(
  client: WebdriverIO.Browser,
  name: string,
  parentCollectionId: string | null
): Promise<CollectionRow> {
  return invokeTauri<CollectionRow>(client, 'create_collection', {
    input: {
      name,
      parent_collection_id: parentCollectionId
    }
  });
}

async function createNoteFixture(
  client: WebdriverIO.Browser,
  title: string,
  body: string,
  parentCollectionId: string | null
): Promise<NoteRow> {
  return invokeTauri<NoteRow>(client, 'create_note', {
    input: {
      title,
      body,
      parent_collection_id: parentCollectionId,
      note_kind: 'markdown'
    }
  });
}

async function loadNoteFixture(
  client: WebdriverIO.Browser,
  id: string
): Promise<NoteRow> {
  return invokeTauri<NoteRow>(client, 'load_note', { id });
}

async function saveNoteBodyFixture(
  client: WebdriverIO.Browser,
  id: string,
  body: string
): Promise<NoteRow> {
  return invokeTauri<NoteRow>(client, 'save_note', {
    input: { id, body }
  });
}

async function uploadAssetFixture(
  client: WebdriverIO.Browser,
  owningNoteId: string,
  bytes: number[]
): Promise<AssetRow> {
  return invokeTauri<AssetRow>(client, 'upload_drawing_asset', {
    input: {
      owning_note_id: owningNoteId,
      mime_type: 'image/png',
      bytes
    }
  });
}

async function fetchAssetFixture(
  client: WebdriverIO.Browser,
  id: string
): Promise<AssetRow> {
  return invokeTauri<AssetRow>(client, 'fetch_drawing_asset', { id });
}

async function moveNoteFixture(
  client: WebdriverIO.Browser,
  noteId: string,
  targetCollectionId: string | null
): Promise<void> {
  await invokeTauri(client, 'move_many', {
    items: [{ kind: 'note', id: noteId }],
    targetCollectionId
  });
}

async function expectNoteBodyContains(
  client: WebdriverIO.Browser,
  noteId: string,
  text: string
): Promise<void> {
  await client.waitUntil(
    async () => {
      try {
        const note = await loadNoteFixture(client, noteId);
        return note.body?.includes(text) === true;
      } catch {
        return false;
      }
    },
    {
      timeout: 60_000,
      timeoutMsg: `note ${noteId} did not contain expected text: ${text}`
    }
  );
}

describe('T4 sharing a folder', function () {
  this.timeout(360_000);

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
    await waitForClientsReady({ browserA, browserB });

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
  const RUN_ID = Date.now();
  const SHARED_FOLDER = `Shared Project ${RUN_ID}`;
  let noteToMoveOut:
    | {
        id: string;
        title: string;
      }
    | undefined;

  // --- 4.1 Outgoing share creation (P1) ---
  it('A shares a folder → invite succeeds and folder flags shared-by-me', async () => {
    // Seed a folder on A via the validated draft-input flow. Subtree content
    // convergence is covered by 4.7 below; this path keeps to creating a
    // share and answering its invitation.
    await A.newRootFolder(SHARED_FOLDER);

    // Right-click the folder → "Sharing" ▸ "Share folder…" opens the dialog.
    await A.clickElement(A.treeItem(SHARED_FOLDER), { button: 'right' });
    await A.clickMenuItem('Sharing');
    await A.clickMenuItem('Share folder…');

    // A has shared nothing with B yet, so B's key is new to this device.
    const unseen = await invokeTauri<UserKeyRow>(browserA, 'user_key_info', {
      username: accounts.recipient.username
    });
    expect(unseen.standing).toBe('new');

    // Fill "Users" with B's real username, pick "Can edit", then "Invite".
    await A.setValue('Users', accounts.recipient.username);
    await setSharePermission(browserA, 'Can edit');
    await submitShareInvite(browserA);

    // Success: the dialog closes and the folder now carries the shared-by-me
    // badge — a Share2 icon whose accessible name is "Shared" (nav.shared),
    // rendered inside the folder's tree row (FileExplorer.svelte).
    await expectSharedByMeBadge(browserA, SHARED_FOLDER);

    // Sharing relied on B's key, so A remembers it now. And it is B's key:
    // the digits A is shown for B are the ones B's own app shows.
    const seen = await invokeTauri<UserKeyRow>(browserA, 'user_key_info', {
      username: accounts.recipient.username
    });
    expect(seen.standing).toBe('known');
    expect(seen.fingerprint).toBe(
      await invokeTauri<string>(browserB, 'own_key_fingerprint')
    );

    await A.click('Cancel');
  });

  // The invitation carries the folder's name, which B reads before
  // answering (ShareInviteNotificationWidget.svelte).
  const shareTitle = (folder: string) =>
    `${accounts.sender.username} shared “${folder}” with you`;

  // --- 4.2 An invitation is one notification that names the folder (P1) ---
  it('B is told which folder A shared before accepting anything', async () => {
    // The server tells B's device that an invitation arrived, and the
    // notifications list it without a restart.
    await browserB.waitUntil(
      async () => {
        await B.openNotifications();
        return B.isDisplayed(shareTitle(SHARED_FOLDER), 2_000);
      },
      {
        timeout: 60_000,
        timeoutMsg: 'the share invitation did not reach B on its own'
      }
    );
    await expect(
      B.allByName(shareTitle(SHARED_FOLDER))
    ).toBeElementsArrayOfSize(1);

    // Reading the name took nothing: the invitation still waits, B is not a
    // member, and nothing of the folder is on B's device.
    const waiting = await invokeTauri<IncomingShareFixture[]>(
      browserB,
      'list_incoming_shares'
    );
    expect(waiting.map((share) => share.name)).toEqual([SHARED_FOLDER]);
    expect(waiting[0].sender_username).toBe(accounts.sender.username);
    expect(waiting[0].access_level).toBe('read_write');
    const folders = await listCollections(browserB);
    expect(folders.some((folder) => folder.name === SHARED_FOLDER)).toBe(false);
  });

  // --- 4.3 Accept a share (P1) ---
  it('B accepts the share → shared root lands under "Shared", not Home', async () => {
    // Accept the (only) invitation → the notification dismisses and the sync
    // it asks for pulls the shared root in.
    await B.click('Accept');
    await expect(B.byName(shareTitle(SHARED_FOLDER))).not.toBeDisplayed();
    await browserB.reloadSession();
    await browserB.$('aria/Welcome').waitForDisplayed({ timeout: 30_000 });
    B = clientHelpers(browserB);

    // Accept asks for a sync that pulls the share's collection in.
    // Reloading immediately after can outrun it, and under this tier's
    // memory pressure a single push/pull round often finishes before the shared
    // root has crossed the wire. Re-sync (re-pushing A as well as re-pulling B)
    // until the folder lands under the "Shared" source, rather than trusting one
    // post-accept sync.
    await selectTreeSource(browserB, 'Shared');
    await browserB.waitUntil(
      async () => {
        await syncClient(browserA);
        await syncClient(browserB);
        return B.isDisplayed(SHARED_FOLDER, 1_000);
      },
      {
        timeout: 180_000,
        timeoutMsg: 'shared root did not land under "Shared" after accept'
      }
    );

    // The shared root lands under the "Shared" source, NOT Home.
    await expect(B.treeItem(SHARED_FOLDER)).toBeDisplayed();

    // Regression guard: the shared root must NOT show up in Home (that would
    // mean the "Shared" projection didn't run — shared_role/share_id unset).
    await selectTreeSource(browserB, 'Home');
    await expect(B.treeItem(SHARED_FOLDER)).not.toBeDisplayed();
  });

  const SECOND_FOLDER = `Second Share ${RUN_ID}`;

  // --- 4.4 Decline a share (P2) ---
  it('B declines a second share → it does not come back on rescan', async () => {
    // A seeds and shares a SECOND folder to B.
    await A.newRootFolder(SECOND_FOLDER);
    await A.clickElement(A.treeItem(SECOND_FOLDER), { button: 'right' });
    await A.clickMenuItem('Sharing');
    await A.clickMenuItem('Share folder…');
    await A.setValue('Users', accounts.recipient.username);
    await setSharePermission(browserA, 'Can edit');
    await submitShareInvite(browserA);
    await expectSharedByMeBadge(browserA, SECOND_FOLDER);

    await browserB.reloadSession();
    await browserB.$('aria/Welcome').waitForDisplayed({ timeout: 30_000 });
    B = clientHelpers(browserB);

    // B sees the invitation and declines it.
    await B.openNotifications();
    await expect(B.byName(shareTitle(SECOND_FOLDER))).toBeDisplayed();
    await B.click('Decline');
    await expect(B.byName(shareTitle(SECOND_FOLDER))).not.toBeDisplayed();

    // No shared folder is added under "Shared".
    await selectTreeSource(browserB, 'Shared');
    await expect(B.treeItem(SECOND_FOLDER)).not.toBeDisplayed();

    // Regression guard: a rescan (a restart lists the invitations again)
    // must NOT bring the declined one back. The server has dropped it.
    await browserB.reloadSession();
    await browserB.$('aria/Welcome').waitForDisplayed({ timeout: 30_000 });
    B = clientHelpers(browserB);
    await B.openNotifications();
    await expect(B.byName(shareTitle(SECOND_FOLDER))).not.toBeDisplayed();
    const waiting = await invokeTauri<IncomingShareFixture[]>(
      browserB,
      'list_incoming_shares'
    );
    expect(waiting).toEqual([]);
  });

  // --- 4.6 An invitation to something that is not a shared folder (P3) ---
  it('an invitation to another kind of collection is never offered as a share', async () => {
    // Anyone on the server can invite B to a collection of their own making.
    // Only a shared folder is something this app shares, so only that is
    // shown. Offering anything else to accept would let its maker put a
    // collection of their choosing among B's.
    const foreign = await invokeTauri<{ collection_uid: string }>(
      browserA,
      'e2e_create_standalone_collection_invite',
      {
        input: {
          username: accounts.recipient.username,
          collection_type: `mindstream.e2e.foreign.${RUN_ID}`,
          name: `Foreign ${RUN_ID}`,
          access_level: 'read_write'
        }
      }
    );
    expect(foreign.collection_uid.length).toBeGreaterThan(0);

    await browserB.reloadSession();
    await browserB.$('aria/Welcome').waitForDisplayed({ timeout: 30_000 });
    B = clientHelpers(browserB);

    await B.openNotifications();
    await expect(
      B.allByName(shareTitle(`Foreign ${RUN_ID}`))
    ).toBeElementsArrayOfSize(0);
    const waiting = await invokeTauri<IncomingShareFixture[]>(
      browserB,
      'list_incoming_shares'
    );
    expect(waiting).toEqual([]);
  });

  // --- 4.7 Shared subtree content converges (P1) ---
  it('shared notes + assets converge, and post-share additions inherit the scope', async () => {
    const sharedId = await findCollectionId(browserA, SHARED_FOLDER);
    const sharedNoteTitle = `Scope note ${RUN_ID}`;
    const nestedFolderName = `Scope nested ${RUN_ID}`;
    const nestedNoteTitle = `Nested note ${RUN_ID}`;
    const movedNoteTitle = `Moved into scope ${RUN_ID}`;
    const assetNoteTitle = `Asset note ${RUN_ID}`;
    const sharedBody = `shared body ${RUN_ID}`;
    const nestedBody = `nested body ${RUN_ID}`;
    const movedBody = `moved body ${RUN_ID}`;
    const assetBody = `asset body ${RUN_ID}`;
    const recipientEdit = `recipient edit ${RUN_ID}`;
    const tinyPng = [
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
      0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84,
      120, 156, 99, 248, 255, 255, 63, 0, 5, 254, 2, 254, 167, 53, 129, 132, 0,
      0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130
    ];

    const sharedNote = await createNoteFixture(
      browserA,
      sharedNoteTitle,
      sharedBody,
      sharedId
    );
    const nestedFolder = await createCollectionFixture(
      browserA,
      nestedFolderName,
      sharedId
    );
    const nestedNote = await createNoteFixture(
      browserA,
      nestedNoteTitle,
      nestedBody,
      nestedFolder.id
    );
    const movedNote = await createNoteFixture(
      browserA,
      movedNoteTitle,
      movedBody,
      null
    );
    await moveNoteFixture(browserA, movedNote.id, sharedId);
    noteToMoveOut = { id: movedNote.id, title: movedNoteTitle };

    const assetNote = await createNoteFixture(
      browserA,
      assetNoteTitle,
      assetBody,
      sharedId
    );
    const asset = await uploadAssetFixture(browserA, assetNote.id, tinyPng);
    await saveNoteBodyFixture(
      browserA,
      assetNote.id,
      `${assetBody}\n\n![tiny test image](asset:mindstream/${asset.id})`
    );

    await syncClient(browserA);

    await browserB.reloadSession();
    await browserB.$('aria/Welcome').waitForDisplayed({ timeout: 30_000 });
    B = clientHelpers(browserB);
    await syncClient(browserB);
    await selectTreeSource(browserB, 'Shared');

    await B.click(SHARED_FOLDER);
    await expect(B.treeItem(sharedNoteTitle)).toBeDisplayed();
    await expect(B.treeItem(nestedFolderName)).toBeDisplayed();
    await B.click(nestedFolderName);
    await expect(B.treeItem(nestedNoteTitle)).toBeDisplayed();
    await expect(B.treeItem(movedNoteTitle)).toBeDisplayed();
    await expect(B.treeItem(assetNoteTitle)).toBeDisplayed();

    await expectNoteBodyContains(browserB, sharedNote.id, sharedBody);
    await expectNoteBodyContains(browserB, nestedNote.id, nestedBody);
    await expectNoteBodyContains(browserB, movedNote.id, movedBody);
    await expectNoteBodyContains(browserB, assetNote.id, asset.id);
    const fetchedAsset = await fetchAssetFixture(browserB, asset.id);
    expect(fetchedAsset.bytes).toEqual(tinyPng);

    await B.click(sharedNoteTitle);
    await B.insertText(browserB.$('.ProseMirror'), `\n\n${recipientEdit}`);
    await expectNoteBodyContains(browserB, sharedNote.id, recipientEdit);

    await syncClient(browserB);
    await syncClient(browserA);
    await expectNoteBodyContains(browserA, sharedNote.id, recipientEdit);
  });

  // --- 4.7b Move out of a shared folder re-homes back to the vault (P2) ---
  it('moving a note out of the shared folder removes it from the recipient', async function () {
    if (!noteToMoveOut) {
      throw new Error('4.7b requires the 4.7 shared note fixture');
    }

    await moveNoteFixture(browserA, noteToMoveOut.id, null);
    const ownerNote = await loadNoteFixture(browserA, noteToMoveOut.id);
    expect(ownerNote.parent_collection_id).toBeNull();

    await syncClient(browserA);

    await browserB.reloadSession();
    await browserB.$('aria/Welcome').waitForDisplayed({ timeout: 30_000 });
    B = clientHelpers(browserB);
    await syncClient(browserB);
    await selectTreeSource(browserB, 'Shared');
    await B.click(SHARED_FOLDER);

    await expect(B.treeItem(noteToMoveOut.title)).not.toBeDisplayed();
  });

  const LINK_FOLDER = `Link Folder ${RUN_ID}`;

  // --- 4.11 Joining by an invite link (P1) ---
  it('A makes an invite link → B looks at it, joins and gets the folder', async () => {
    // A folder of A's own with a note in it, shared with nobody.
    await closeSharingDialogs(browserA);
    await selectTreeSource(browserA, 'Home');
    await A.newRootFolder(LINK_FOLDER);
    const folderId = await findCollectionId(browserA, LINK_FOLDER);
    const noteTitle = `Linked note ${RUN_ID}`;
    const noteBody = `linked body ${RUN_ID}`;
    const note = await createNoteFixture(
      browserA,
      noteTitle,
      noteBody,
      folderId
    );

    // "Sharing" ▸ "Share folder…" ▸ "Invite with a link" leads to the links
    // of a folder that is not shared yet. Making one shares it.
    await A.clickElement(A.treeItem(LINK_FOLDER), { button: 'right' });
    await A.clickMenuItem('Sharing');
    await A.clickMenuItem('Share folder…');
    await clickDialogButton(
      browserA,
      'share-collection-title',
      'Invite with a link'
    );
    await browserA
      .$('[data-testid="share-links"]')
      .waitForDisplayed({ timeout: 30_000 });
    await browserA.execute(() => {
      const select = document.querySelector<HTMLSelectElement>(
        '[data-testid="share-links"] select[aria-label="Permission"]'
      );
      if (!select) throw new Error('link permission select not found');
      select.value = 'read_write';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await clickDialogButton(browserA, 'manage-access-title', 'Create link');

    // The link is shown once, with its secret after the `#`.
    const linkText = browserA.$('[data-testid="share-link-text"]');
    await linkText.waitForDisplayed({ timeout: 60_000 });
    const link = (await linkText.getText()).trim();
    expect(link).toMatch(/\/join\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]{43}$/);
    expect(link.startsWith(backendUrl().replace(/\/+$/, ''))).toBe(true);

    await expectSharedByMeBadge(browserA, LINK_FOLDER);
    const made = await invokeTauri<ShareLinkRow[]>(
      browserA,
      'list_share_links',
      { collectionId: folderId }
    );
    expect(made).toHaveLength(1);
    expect(made[0].uses).toBe(0);
    expect(made[0].max_uses).toBe(1);
    expect(made[0].access_level).toBe('read_write');
    await closeSharingDialogs(browserA);

    // The folder moves into its own collection with A's next sync.
    await syncClient(browserA);

    // B pastes the link where the shared folders are listed.
    await closeSharingDialogs(browserB);
    await selectTreeSource(browserB, 'Shared');
    await openTreeBackgroundMenu(browserB);
    await B.clickMenuItem('Join shared folder…');
    await B.setValue('Invite link', link);
    await clickDialogButton(browserB, 'join-link-title', 'Continue');

    // Looking shows who invites to what, and takes nothing.
    const preview = browserB.$('[data-testid="join-link-preview"]');
    await preview.waitForDisplayed({ timeout: 60_000 });
    const shown = await preview.getText();
    expect(shown).toContain(
      `${accounts.sender.username} invites you to “${LINK_FOLDER}”`
    );
    expect(shown).toContain('Can edit');
    const before = await listCollections(browserB);
    expect(before.some((folder) => folder.name === LINK_FOLDER)).toBe(false);
    const unused = await invokeTauri<ShareLinkRow[]>(
      browserA,
      'list_share_links',
      { collectionId: folderId }
    );
    expect(unused.map((row) => row.uses)).toEqual([0]);

    // Joining closes the dialog and asks for a sync that pulls the folder in.
    await clickDialogButton(browserB, 'join-link-title', 'Join');
    await preview.waitForExist({ reverse: true, timeout: 60_000 });
    await browserB.waitUntil(
      async () => {
        await syncClient(browserA);
        await syncClient(browserB);
        return B.isDisplayed(LINK_FOLDER, 1_000);
      },
      {
        timeout: 180_000,
        timeoutMsg: 'the folder did not arrive after joining by a link'
      }
    );
    await expect(B.treeItem(LINK_FOLDER)).toBeDisplayed();
    await expectNoteBodyContains(browserB, note.id, noteBody);

    // B holds the folder as a shared one, with the rights the link gave.
    const joined = (await listCollections(browserB)).find(
      (folder) => folder.name === LINK_FOLDER
    );
    expect(joined?.shared_role).toBe('read_write');
    expect(joined?.share_id).toBeTruthy();

    // A sees B among the members, and the link for one person is used up.
    // It stays listed until it expires, so that A sees it was used.
    const members = await invokeTauri<MemberRow[]>(
      browserA,
      'list_collection_members',
      { collectionId: folderId }
    );
    expect(
      members.find(
        (member) =>
          member.username.toLowerCase() ===
          accounts.recipient.username.toLowerCase()
      )?.access_level
    ).toBe('read_write');
    const left = await invokeTauri<ShareLinkRow[]>(
      browserA,
      'list_share_links',
      { collectionId: folderId }
    );
    expect(left.map((row) => [row.uses, row.max_uses])).toEqual([[1, 1]]);
    // Used up means it lets nobody else in, not even to look.
    expect(await refusalOf(browserB, 'open_share_link', { link })).toBe(
      'link_used'
    );

    // It is a shared folder like any other: not in Home.
    await selectTreeSource(browserB, 'Home');
    await expect(B.treeItem(LINK_FOLDER)).not.toBeDisplayed();
  });

  const KEY_FOLDER = `Key Folder ${RUN_ID}`;

  // --- 4.12 A key that is not the one remembered (P1) ---
  it('a changed key holds an invitation back, both ways, until it was seen', async () => {
    // B accepted A's first invitation, so B remembers A's key, and it is the
    // key A's own app shows.
    const senderKey = await invokeTauri<UserKeyRow>(browserB, 'user_key_info', {
      username: accounts.sender.username
    });
    expect(senderKey.standing).toBe('known');
    expect(senderKey.fingerprint).toBe(
      await invokeTauri<string>(browserA, 'own_key_fingerprint')
    );

    // Sending. A's device is made to remember another key for B, as it would
    // if the server had given A a different key before.
    await invokeTauri(browserA, 'e2e_remember_other_key', {
      username: accounts.recipient.username
    });
    await closeSharingDialogs(browserA);
    await selectTreeSource(browserA, 'Home');
    await A.newRootFolder(KEY_FOLDER);
    const folderId = await findCollectionId(browserA, KEY_FOLDER);
    await A.clickElement(A.treeItem(KEY_FOLDER), { button: 'right' });
    await A.clickMenuItem('Sharing');
    await A.clickMenuItem('Share folder…');
    await A.setValue('Users', accounts.recipient.username);
    await setSharePermission(browserA, 'Can view');
    await submitShareInvite(browserA);

    // The dialog shows what changed, with both keys, and nothing was made
    // or sent.
    const notice = browserA.$('[data-testid="key-changed-notice"]');
    await notice.waitForDisplayed({ timeout: 60_000 });
    await browserA.waitUntil(
      async () =>
        (await notice.$$('[data-testid="key-fingerprint"]').length) === 2,
      { timeout: 60_000, timeoutMsg: 'the two keys were not shown' }
    );
    const state = await invokeTauri<{ share_id: string | null }>(
      browserA,
      'get_collection_share_state',
      { collectionId: folderId }
    );
    expect(state.share_id).toBeNull();
    const none = await invokeTauri<IncomingShareFixture[]>(
      browserB,
      'list_incoming_shares'
    );
    expect(none.some((share) => share.name === KEY_FOLDER)).toBe(false);

    // Saying to share with the new key sends it, and A remembers that key.
    await clickDialogButton(
      browserA,
      'share-collection-title',
      'Share with the new key'
    );
    await expectSharedByMeBadge(browserA, KEY_FOLDER);
    const trusted = await invokeTauri<UserKeyRow>(browserA, 'user_key_info', {
      username: accounts.recipient.username
    });
    expect(trusted.standing).toBe('known');
    await closeSharingDialogs(browserA);
    await syncClient(browserA);

    // Receiving. B's device is made to remember another key for A.
    await invokeTauri(browserB, 'e2e_remember_other_key', {
      username: accounts.sender.username
    });
    await browserB.reloadSession();
    await browserB.$('aria/Welcome').waitForDisplayed({ timeout: 30_000 });
    B = clientHelpers(browserB);

    // The invitation is listed with the change, and the backend will not
    // accept it as if nothing had happened.
    let waiting: (IncomingShareFixture & { sender_key: UserKeyRow | null })[] =
      [];
    await browserB.waitUntil(
      async () => {
        waiting = await invokeTauri(browserB, 'list_incoming_shares');
        return waiting.some((share) => share.name === KEY_FOLDER);
      },
      { timeout: 60_000, timeoutMsg: 'the invitation did not reach B' }
    );
    const invitation = waiting.find((share) => share.name === KEY_FOLDER);
    expect(invitation?.sender_key?.standing).toBe('changed');
    expect(invitation?.sender_key?.fingerprint).toBe(senderKey.fingerprint);
    expect(
      await refusalOf(browserB, 'accept_share', {
        invitationId: invitation?.invitation_id
      })
    ).toBe('key_changed');

    // The notification says so, and offers only "Accept anyway".
    await browserB.waitUntil(
      async () => {
        await B.openNotifications();
        return browserB
          .$('[data-testid="share-invite-key-changed"]')
          .isDisplayed();
      },
      { timeout: 60_000, timeoutMsg: 'the changed key was not shown to B' }
    );
    await expect(B.byName('Accept')).not.toBeDisplayed();
    await B.click('Accept anyway');

    // Accepted by choice: the folder arrives, and B remembers A's key again.
    await selectTreeSource(browserB, 'Shared');
    await browserB.waitUntil(
      async () => {
        await syncClient(browserA);
        await syncClient(browserB);
        return B.isDisplayed(KEY_FOLDER, 1_000);
      },
      {
        timeout: 180_000,
        timeoutMsg: 'the folder did not arrive after accepting anyway'
      }
    );
    const again = await invokeTauri<UserKeyRow>(browserB, 'user_key_info', {
      username: accounts.sender.username
    });
    expect(again.standing).toBe('known');
  });

  // 4.8–4.9 require an owner second device (A2) and are covered by
  // sharing-multi-device.e2e.ts under test:e2e:app:multi:a2.
});
