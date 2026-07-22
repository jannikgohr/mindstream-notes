/**
 * T4 — collection sharing (manifest bundles), docs/e2e/flows.md §4.
 * Every flow here is Etebase network IO with no unit
 * coverage, and the meaningful ones need **two distinct accounts** — a sender
 * (A) and a recipient (B) whose public key A resolves via `fetch_user_profile`.
 * That is a stronger requirement than the collab.e2e.ts matrix (one account,
 * two devices): these must provision two real users on the same backend.
 *
 * Like collab.e2e.ts this is gated to skip until the two-client seam runs (wdio
 * multiremote → `browserA`/`browserB`, two driver processes) plus two-account
 * provisioning against Etebase (docs/e2e/backend-stack.md).
 *
 * Status: flows 4.1–4.6, the core 4.7 subtree convergence path, and 4.7b
 * move-out re-home are IMPLEMENTED and validated against the live two-app +
 * backend session. The owner-second-device 4.8–4.9 re-home cases live in
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
 *   - bundle notification:      "{sender} shared “{name}”"  / pending variant
 *   - bundle actions:           "Accept" / "Decline"
 *   - shared tree section:      "Shared"            (ui.nav.shared)
 *   - view-only editor banner:  ui.editor.viewonly.banner
 */

import { expect } from '@wdio/globals';

import { provisionTwoAccounts, type TwoAccounts } from '../helpers/accounts.js';
import { backendUrl } from '../helpers/backend.js';
import {
  clientHelpers,
  loginClient,
  syncClient,
  waitForClientsReady,
  type ClientHelpers
} from '../helpers/harness.js';

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

interface CollectionRow {
  id: string;
  name: string;
  parent_collection_id: string | null;
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

interface IncomingShareBundleFixture {
  name: string | null;
  pending: boolean;
  complete: boolean;
  warnings: string[];
  parts: Array<{
    expected_collection_type: string;
    invitation: unknown | null;
  }>;
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

describe('T4 collection sharing (manifest bundles)', function () {
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
    // convergence is covered by the 4.7 skeleton below; this active path keeps
    // focus on manifest bundle creation/accept/decline.
    await A.newRootFolder(SHARED_FOLDER);

    // Right-click the folder → "Sharing" ▸ "Share folder…" opens the dialog.
    await A.clickElement(A.treeItem(SHARED_FOLDER), { button: 'right' });
    await A.clickMenuItem('Sharing');
    await A.clickMenuItem('Share folder…');

    // Fill "Users" with B's real username, pick "Can edit", then "Invite".
    await A.setValue('Users', accounts.recipient.username);
    await setSharePermission(browserA, 'Can edit');
    await submitShareInvite(browserA);

    // Success: the dialog closes and the folder now carries the shared-by-me
    // badge — a Share2 icon whose accessible name is "Shared" (nav.shared),
    // rendered inside the folder's tree row (FileExplorer.svelte).
    await expectSharedByMeBadge(browserA, SHARED_FOLDER);

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
    // The current packaged app scans collection invites when the notification
    // center mounts. Restart B after A sends the invite so this test observes
    // the newly created server-side invitations without relying on a rebuild.
    await browserB.reloadSession();
    await browserB.$('aria/Welcome').waitForDisplayed({ timeout: 30_000 });
    B = clientHelpers(browserB);

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
    await browserB.reloadSession();
    await browserB.$('aria/Welcome').waitForDisplayed({ timeout: 30_000 });
    B = clientHelpers(browserB);

    // Accept kicks off a scoped sync that joins B to the share's collections.
    // Reloading immediately after can outrun that join, and under this tier's
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
  const INCOMPLETE_FOLDER = `Incomplete Share ${RUN_ID}`;

  // --- 4.4 Decline a share bundle (P2) ---
  it('B declines a second bundle → it does not loop back on rescan', async () => {
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

    // B sees the (pending) bundle and declines it.
    await B.openNotifications();
    await expect(B.byName(pendingBundleTitle())).toBeDisplayed();
    await B.click('Decline');
    await expect(B.byName(pendingBundleTitle())).not.toBeDisplayed();

    // No shared folder is added under "Shared".
    await selectTreeSource(browserB, 'Shared');
    await expect(B.treeItem(SECOND_FOLDER)).not.toBeDisplayed();

    // Regression guard: a rescan (reopening the center re-lists manifest
    // collections) must NOT resurrect the declined bundle. Decline leaves the
    // auto-accepted manifest collection behind precisely so it can't reappear.
    await B.openNotifications();
    await expect(B.byName(pendingBundleTitle())).not.toBeDisplayed();
  });

  // --- 4.5 Incomplete bundle can't be accepted (P2) ---
  it('an incomplete bundle disables Accept and shows the incomplete warning', async () => {
    const bundle = await invokeTauri<{ manifest_collection_uid: string }>(
      browserA,
      'e2e_create_incomplete_share_bundle',
      {
        input: {
          username: accounts.recipient.username,
          name: INCOMPLETE_FOLDER,
          access_level: 'read_write'
        }
      }
    );

    await browserB.reloadSession();
    await browserB.$('aria/Welcome').waitForDisplayed({ timeout: 30_000 });
    B = clientHelpers(browserB);
    await invokeTauri(browserB, 'e2e_accept_share_manifest_only', {
      manifestCollectionUid: bundle.manifest_collection_uid
    });

    await browserB.reloadSession();
    await browserB.$('aria/Welcome').waitForDisplayed({ timeout: 30_000 });
    B = clientHelpers(browserB);

    const incoming = await invokeTauri<{
      bundles: IncomingShareBundleFixture[];
    }>(browserB, 'list_incoming_share_bundles');
    const incompleteBundle = incoming.bundles.find(
      (candidate) => candidate.name === INCOMPLETE_FOLDER
    );
    expect(incompleteBundle).toBeDefined();
    expect(incompleteBundle?.pending).toBe(false);
    expect(incompleteBundle?.complete).toBe(false);
    expect(
      incompleteBundle?.parts.find(
        (part) => part.expected_collection_type === 'mindstream.assets'
      )?.invitation
    ).toBeNull();
    expect(incompleteBundle?.warnings.join('\n')).toContain(
      'missing invitation for required Assets collection'
    );

    await B.openNotifications();
    await browserB.waitUntil(
      () =>
        browserB.execute((name: string) => {
          const item = Array.from(
            document.querySelectorAll<HTMLElement>('div.rounded-md')
          ).find((candidate) => candidate.textContent?.includes(name));
          if (!item) {
            return false;
          }
          const text = item.textContent ?? '';
          const buttons = Array.from(item.querySelectorAll('button'));
          const buttonState = (label: string) => {
            const button = buttons.find(
              (candidate) => candidate.textContent?.trim() === label
            );
            return button ? { found: true, disabled: button.disabled } : null;
          };
          const accept = buttonState('Accept');
          const decline = buttonState('Decline');
          return (
            text.includes('This share is incomplete') &&
            accept?.disabled === true &&
            decline?.disabled === false
          );
        }, INCOMPLETE_FOLDER),
      {
        timeout: 30_000,
        timeoutMsg: 'incomplete share bundle widget did not render'
      }
    );
    const state = await browserB.execute((name: string) => {
      const item = Array.from(
        document.querySelectorAll<HTMLElement>('div.rounded-md')
      ).find((candidate) => candidate.textContent?.includes(name));
      if (!item) throw new Error('incomplete share notification not found');
      const text = item.textContent ?? '';
      const buttons = Array.from(item.querySelectorAll('button'));
      const buttonState = (label: string) => {
        const button = buttons.find(
          (candidate) => candidate.textContent?.trim() === label
        );
        if (!button) throw new Error(`missing ${label} button`);
        return button.disabled;
      };
      return {
        hasWarning: text.includes('This share is incomplete'),
        acceptDisabled: buttonState('Accept'),
        declineDisabled: buttonState('Decline')
      };
    }, INCOMPLETE_FOLDER);

    expect(state.hasWarning).toBe(true);
    expect(state.acceptDisabled).toBe(true);
    expect(state.declineDisabled).toBe(false);
  });

  // --- 4.6 Non-manifest invitation still surfaces (P3) ---
  it('a lone non-manifest collection invite shows as a legacy collaboration-invite', async () => {
    await invokeTauri(browserA, 'e2e_create_standalone_collection_invite', {
      input: {
        username: accounts.recipient.username,
        collection_type: `mindstream.e2e.legacy.${RUN_ID}`,
        name: `Legacy standalone ${RUN_ID}`,
        access_level: 'read_write'
      }
    });

    await browserB.reloadSession();
    await browserB.$('aria/Welcome').waitForDisplayed({ timeout: 30_000 });
    B = clientHelpers(browserB);

    await B.openNotifications();
    await expect(B.byName(legacyInviteTitle())).toBeDisplayed();
    await expect(B.allByName(legacyInviteTitle())).toBeElementsArrayOfSize(1);
    await expect(B.allByName(pendingBundleTitle())).toBeElementsArrayOfSize(0);
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

  // 4.8–4.9 require an owner second device (A2) and are covered by
  // sharing-multi-device.e2e.ts under test:e2e:app:multi:a2.
});
