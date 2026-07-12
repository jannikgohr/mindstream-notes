/**
 * T4 — collection sharing across the OWNER's own two devices (plus a recipient).
 *
 * The core sharing.e2e.ts matrix is sender (A) + recipient (B). This suite adds
 * the case that one is not enough for: account A is signed in on **two** devices
 * (A1 + A2), and A1 shares a folder with account B. It answers three questions
 * the two-client suite can't:
 *
 *   1. Offline-style edit before the share is not lost — a note edited on A1 and
 *      left unpushed (dirty) at the moment F is shared must survive the re-home
 *      into the scope and converge to the recipient (docs/e2e-flows.md §4.8,
 *      approximated here without a true network-offline toggle — see the note on
 *      the relevant `it`).
 *   2. The shared-by-me indicator shows on BOTH of A's devices — A2 must learn
 *      that F is now shared, not just the device that performed the share.
 *   3. Both of A's devices actually hold the shared notes — F and its notes are
 *      present on A2 after it syncs, not stranded on A1.
 *
 * Requires the three-client seam (wdio multiremote → browserA1/browserA2/
 * browserB, three driver processes) and two-account provisioning against
 * Etebase. Run via `pnpm test:e2e:app:multi:a2` with the backend stack up.
 *
 * Accessible names referenced below (from src/lib/settings/i18n/en.json, the
 * same names the SvelteKit UI renders inside the WebView):
 *   - folder context menu:      "Share folder…"     (ui.sharing.menu.shareFolder)
 *   - share dialog user field:  "User"              (ui.sharing.dialog.userLabel)
 *   - share dialog permission:  "Permission"        (ui.sharing.dialog.permissionLabel)
 *   - share dialog submit:      "Invite"            (ui.sharing.dialog.invite)
 *   - shared-by-me badge:       svg[aria-label="Shared"] in the folder tree row
 *   - shared tree section:      "Shared"            (ui.nav.shared)
 */

import { expect } from '@wdio/globals';

import { provisionTwoAccounts, type TwoAccounts } from '../helpers/accounts.js';
import { assertBackendReady, backendUrl } from '../helpers/backend.js';
import {
  clientHelpers,
  loginClient,
  requireBackendE2E,
  syncClient,
  type ClientHelpers
} from '../helpers/harness.js';

// wdio multiremote exposes each capability key as a global browser instance.
// `browserA1`/`browserA2` = account A's two devices, `browserB` = account B.
declare const browserA1: WebdriverIO.Browser;
declare const browserA2: WebdriverIO.Browser;
declare const browserB: WebdriverIO.Browser;

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

async function saveNoteBodyFixture(
  client: WebdriverIO.Browser,
  id: string,
  body: string
): Promise<NoteRow> {
  return invokeTauri<NoteRow>(client, 'save_note', {
    input: { id, body }
  });
}

/**
 * Does the note's body contain `text`? The check runs **inside** the WebView so
 * only the boolean result crosses the WebDriver wire — never the `Note` itself.
 *
 * A synced note carries a populated `yrs_state: Vec<u8>` (the CRDT doc), which
 * Tauri serializes into a large JSON int-array. Returning that whole struct as
 * an `execute/sync` result makes WebKitWebDriver (wry, Linux) fail with "Could
 * not parse script result" — intermittently under this tier's three-WebView
 * memory pressure. Extracting the boolean in-page keeps `yrs_state` off the wire
 * entirely, so the predicate is reliable regardless of note size.
 */
async function noteBodyContains(
  client: WebdriverIO.Browser,
  noteId: string,
  text: string
): Promise<boolean> {
  return client.execute(
    async (id: string, needle: string) => {
      const tauri = window as unknown as {
        __TAURI_INTERNALS__?: {
          invoke?: <R>(
            command: string,
            args?: Record<string, unknown>
          ) => Promise<R>;
        };
      };
      const invoke = tauri.__TAURI_INTERNALS__?.invoke;
      if (!invoke) return false;
      try {
        const note = await invoke<{ body?: string }>('load_note', { id });
        return typeof note?.body === 'string' && note.body.includes(needle);
      } catch {
        return false;
      }
    },
    noteId,
    text
  );
}

async function expectNoteBodyContains(
  client: WebdriverIO.Browser,
  noteId: string,
  text: string
): Promise<void> {
  await client.waitUntil(() => noteBodyContains(client, noteId, text), {
    timeout: 60_000,
    timeoutMsg: `note ${noteId} did not contain expected text: ${text}`
  });
}

/**
 * Drive convergence under memory pressure. This tier runs three release WebViews
 * at once (two of A's devices + B) on top of the backend stack, so the host
 * swaps hard and a *single* push/pull round routinely finishes before the data
 * has actually crossed the wire. The two-client suites get away with one round;
 * here we re-push the source and re-pull the target until `predicate` holds (the
 * data landed in the target's local store), or give up after `rounds`.
 *
 * `source` is re-synced each round because a lagging *push* is as likely as a
 * lagging pull when the sending device is the one being swapped out.
 */
async function syncUntil(
  target: WebdriverIO.Browser,
  predicate: () => Promise<boolean>,
  opts: { source?: WebdriverIO.Browser; rounds?: number } = {}
): Promise<boolean> {
  const rounds = opts.rounds ?? 5;
  for (let round = 0; round < rounds; round += 1) {
    if (opts.source) await syncClient(opts.source);
    await syncClient(target);
    if (await predicate()) return true;
  }
  return predicate();
}

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
    { timeout: 30_000, timeoutMsg: 'share invite button did not enable' }
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

async function hasSharedByMeBadge(
  client: WebdriverIO.Browser,
  folder: string
): Promise<boolean> {
  return client.execute((folderName: string) => {
    const row = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-file-tree-node]')
    ).find((candidate) => candidate.textContent?.includes(folderName));
    return row?.querySelector('svg[aria-label="Shared"]') !== null;
  }, folder);
}

async function expectSharedByMeBadge(
  client: WebdriverIO.Browser,
  folder: string
): Promise<void> {
  await client.waitUntil(() => hasSharedByMeBadge(client, folder), {
    timeout: 180_000,
    timeoutMsg: `shared-by-me badge did not appear for ${folder}`
  });
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

async function reloadShell(
  client: WebdriverIO.Browser
): Promise<ClientHelpers> {
  await client.reloadSession();
  await client.$('aria/Welcome').waitForDisplayed({ timeout: 30_000 });
  return clientHelpers(client);
}

describe('T4 collection sharing across the owner’s two devices', function () {
  this.timeout(600_000);

  // sender = account A (on A1 + A2); recipient = account B (on browserB).
  let accounts: TwoAccounts;
  let A1: ClientHelpers;
  let A2: ClientHelpers;
  let B: ClientHelpers;

  const RUN_ID = Date.now();
  const SHARED_FOLDER = `Two Device Share ${RUN_ID}`;
  const NOTE_TITLE = `Two Device Note ${RUN_ID}`;
  const INITIAL_BODY = `initial body ${RUN_ID}`;
  const PRE_SHARE_EDIT = `pre-share edit ${RUN_ID}`;

  let sharedFolderIdA1: string;
  let sharedNoteId: string;

  before(async function () {
    requireBackendE2E(this);
    await assertBackendReady();
    const server = backendUrl();

    // One sender + one recipient account. A1 and A2 both sign into the sender;
    // that's the whole point — two devices, one account.
    process.env.MINDSTREAM_E2E_FRESH_ACCOUNTS = '1';
    accounts = await provisionTwoAccounts(server);

    await loginClient(browserA1, {
      serverUrl: server,
      username: accounts.sender.username,
      password: accounts.sender.password
    });
    await loginClient(browserA2, {
      serverUrl: server,
      username: accounts.sender.username,
      password: accounts.sender.password
    });
    await loginClient(browserB, {
      serverUrl: server,
      username: accounts.recipient.username,
      password: accounts.recipient.password
    });

    A1 = clientHelpers(browserA1);
    A2 = clientHelpers(browserA2);
    B = clientHelpers(browserB);
  });

  // --- Baseline: the same account's vault reaches both devices ---
  it('A1 seeds a folder + note that converge on A2 (same-account vault sync)', async () => {
    await A1.newRootFolder(SHARED_FOLDER);
    sharedFolderIdA1 = await findCollectionId(browserA1, SHARED_FOLDER);
    const note = await createNoteFixture(
      browserA1,
      NOTE_TITLE,
      INITIAL_BODY,
      sharedFolderIdA1
    );
    sharedNoteId = note.id;

    // Both devices stay on the shell they logged into (no reload before the
    // first sync, per the proven sync-history recipe). Assert convergence at the
    // DB layer FIRST — a passing note-body check proves the folder + note reached
    // A2's store — then check the tree projection, so a failure separates "data
    // never synced" from "synced but didn't render". `syncUntil` re-pushes A1 and
    // re-pulls A2 across several rounds because under this tier's memory pressure
    // one round often finishes before the data has crossed the wire.
    const converged = await syncUntil(
      browserA2,
      () => noteBodyContains(browserA2, sharedNoteId, INITIAL_BODY),
      { source: browserA1 }
    );
    expect(converged).toBe(true);

    await A2.treeItem(SHARED_FOLDER).waitForDisplayed({ timeout: 30_000 });
    await A2.click(SHARED_FOLDER);
    await A2.treeItem(NOTE_TITLE).waitForDisplayed({ timeout: 30_000 });
  });

  // --- 1. Offline-style edit before the share survives the re-home ---
  it('an unpushed edit made before the share is not lost when A1 shares the folder', async () => {
    // Edit the note on A1 and DO NOT sync — the row is now dirty/unpushed, the
    // same precondition as an edit made while offline. A true network-offline
    // toggle (docs/e2e-flows.md §4.8) doesn't exist yet; leaving the edit
    // unpushed reproduces the crux: the local edit must merge into the scope
    // rather than be clobbered when the folder re-homes on share.
    await saveNoteBodyFixture(
      browserA1,
      sharedNoteId,
      `${INITIAL_BODY}\n\n${PRE_SHARE_EDIT}`
    );

    // Now share the folder with B (Can edit). This re-homes F into a scope.
    await A1.clickElement(A1.treeItem(SHARED_FOLDER), { button: 'right' });
    await A1.clickMenuItem('Share folder…');
    await A1.setValue('User', accounts.recipient.username);
    await setSharePermission(browserA1, 'Can edit');
    await submitShareInvite(browserA1);
    await expectSharedByMeBadge(browserA1, SHARED_FOLDER);
    await A1.click('Cancel');

    await syncClient(browserA1);

    // The pre-share edit survives on A1: both the original body and the edit
    // are still present (no re-home clobber, no orphan revert).
    await expectNoteBodyContains(browserA1, sharedNoteId, INITIAL_BODY);
    await expectNoteBodyContains(browserA1, sharedNoteId, PRE_SHARE_EDIT);
  });

  // --- 2. Share indicator appears on BOTH of A's devices ---
  it('A2 shows the shared-by-me badge on the folder after it syncs', async () => {
    A2 = await reloadShell(browserA2);

    // The owner's *other* device must learn the folder is shared-by-me — not
    // render it as a foreign "shared with me" root. The Share2 badge (accessible
    // name "Shared") in the folder's tree row is the shared-by-me indicator.
    // `expectSharedByMeBadge` only polls the DOM; under this tier's memory
    // pressure the share metadata needs several push/pull rounds to arrive, so
    // drive re-syncs until the badge renders before the fixed-wait assertion.
    const badged = await syncUntil(
      browserA2,
      () => hasSharedByMeBadge(browserA2, SHARED_FOLDER),
      { source: browserA1 }
    );
    expect(badged).toBe(true);
    await expectSharedByMeBadge(browserA2, SHARED_FOLDER);

    // Regression guard: as A's own folder it stays in Home, and must NOT be
    // projected under the recipient-facing "Shared with me" source on A2.
    await selectTreeSource(browserA2, 'Shared');
    await expect(A2.treeItem(SHARED_FOLDER)).not.toBeDisplayed();
    await selectTreeSource(browserA2, 'Home');
    await expect(A2.treeItem(SHARED_FOLDER)).toBeDisplayed();
  });

  // --- 3. Both of A's devices actually hold the shared notes ---
  it('A2 still holds the folder’s notes with the pre-share edit merged in', async () => {
    const hasEdit = await syncUntil(
      browserA2,
      () => noteBodyContains(browserA2, sharedNoteId, PRE_SHARE_EDIT),
      { source: browserA1 }
    );
    expect(hasEdit).toBe(true);

    await A2.treeItem(SHARED_FOLDER).waitForDisplayed({ timeout: 30_000 });
    await A2.click(SHARED_FOLDER);
    await A2.treeItem(NOTE_TITLE).waitForDisplayed({ timeout: 30_000 });
    await expectNoteBodyContains(browserA2, sharedNoteId, INITIAL_BODY);
  });

  // --- Recipient sanity: the share (with the pre-share edit) reaches B ---
  it('B accepts the bundle and receives the folder, note and pre-share edit', async () => {
    B = await reloadShell(browserB);
    await B.openNotifications();
    await B.click('Accept');
    B = await reloadShell(browserB);

    // Drive re-syncs until the shared content (with A1's pre-share edit) lands in
    // B's store, rather than trusting a single post-accept sync under load.
    const received = await syncUntil(
      browserB,
      () => noteBodyContains(browserB, sharedNoteId, PRE_SHARE_EDIT),
      { source: browserA1 }
    );
    expect(received).toBe(true);

    await selectTreeSource(browserB, 'Shared');
    await B.treeItem(SHARED_FOLDER).waitForDisplayed({ timeout: 30_000 });
    await B.click(SHARED_FOLDER);
    await B.treeItem(NOTE_TITLE).waitForDisplayed({ timeout: 30_000 });
    await expectNoteBodyContains(browserB, sharedNoteId, INITIAL_BODY);
    await expectNoteBodyContains(browserB, sharedNoteId, PRE_SHARE_EDIT);
  });
});
