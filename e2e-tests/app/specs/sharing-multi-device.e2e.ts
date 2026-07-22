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
 *      into the scope and converge to the recipient (docs/e2e/flows.md §4.8,
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
 *   - folder context menu:      "Sharing" ▸ "Share folder…"
 *                               (ui.sharing.menu.group ▸ ui.sharing.menu.shareFolder)
 *   - share dialog user field:  "Users"             (ui.sharing.dialog.userLabel;
 *                               plural since the dialog took comma-separated lists)
 *   - share dialog permission:  "Permission"        (ui.sharing.dialog.permissionLabel)
 *   - share dialog submit:      "Invite"            (ui.sharing.dialog.invite)
 *   - shared-by-me badge:       svg[aria-label="Shared"] in the folder tree row
 *   - shared tree section:      "Shared"            (ui.nav.shared)
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
  const rounds = opts.rounds ?? 8;
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
    await waitForClientsReady({ browserA1, browserA2, browserB });

    const server = backendUrl();

    // One sender + one recipient account, both brand-new (no server-side vault
    // yet). A1 and A2 both sign into the sender; that's the whole point — two
    // devices, one account.
    accounts = await provisionTwoAccounts(server);

    // Bring all three devices up CONCURRENTLY. Sync defaults to "live"/enabled,
    // so A1 and A2 both auto-sync on mount and race in `ensure_collection`:
    // each fresh device can mint its own vault Etebase collection for the same
    // singleton. This used to be a permanent split-brain, worked around here by
    // serializing bring-up. The reconcile window (sync fix) now converges both
    // devices onto the lexicographically-smallest collection, so we exercise
    // the real concurrent-bring-up path instead of masking it.
    await Promise.all([
      loginClient(browserA1, {
        serverUrl: server,
        username: accounts.sender.username,
        password: accounts.sender.password
      }),
      loginClient(browserA2, {
        serverUrl: server,
        username: accounts.sender.username,
        password: accounts.sender.password
      }),
      loginClient(browserB, {
        serverUrl: server,
        username: accounts.recipient.username,
        password: accounts.recipient.password
      })
    ]);
    A1 = clientHelpers(browserA1);
    A2 = clientHelpers(browserA2);
    B = clientHelpers(browserB);

    // A1 seeds the folder + note the suite shares. Keep this setup at the IPC
    // layer: with three fresh WebViews booting, a UI toolbar click here can
    // time out at the WebDriver transport before the assertions even begin.
    // The sharing flow itself below still drives the real context-menu UI.
    const folder = await createCollectionFixture(
      browserA1,
      SHARED_FOLDER,
      null
    );
    sharedFolderIdA1 = folder.id;
    const note = await createNoteFixture(
      browserA1,
      NOTE_TITLE,
      INITIAL_BODY,
      sharedFolderIdA1
    );
    sharedNoteId = note.id;
    await syncClient(browserA1);
  });

  // --- Baseline: the same account's vault reaches the second device ---
  it('A1’s seeded folder + note converge on A2 (same-account vault sync)', async () => {
    // A1 published the vault (folder + note) in `before`; A2 adopts it on first
    // sync. Assert convergence at the DB layer FIRST — a passing note-body check
    // proves the folder + note reached A2's store — then check the tree
    // projection, so a failure separates "data never synced" from "synced but
    // didn't render". `syncUntil` re-pulls A2 across several rounds because under
    // this tier's memory pressure one round often finishes before the data has
    // crossed the wire.
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
    // toggle (docs/e2e/flows.md §4.8) doesn't exist yet; leaving the edit
    // unpushed reproduces the crux: the local edit must merge into the scope
    // rather than be clobbered when the folder re-homes on share.
    await saveNoteBodyFixture(
      browserA1,
      sharedNoteId,
      `${INITIAL_BODY}\n\n${PRE_SHARE_EDIT}`
    );

    // Now share the folder with B (Can edit). This re-homes F into a scope.
    await A1.clickElement(A1.treeItem(SHARED_FOLDER), { button: 'right' });
    await A1.clickMenuItem('Sharing');
    await A1.clickMenuItem('Share folder…');
    await A1.setValue('Users', accounts.recipient.username);
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
    // The bundle notification appears only after B's notification center scans
    // the server-side invites on mount. Under this tier's load the first scan can
    // race the invite's arrival, so reload + reopen until the Accept action is
    // present rather than clicking a button that isn't there yet.
    B = await reloadShell(browserB);
    const inviteVisible = async (): Promise<boolean> => {
      await B.openNotifications();
      return B.isDisplayed('Accept', 2_000);
    };
    let sawInvite = await inviteVisible();
    for (let attempt = 0; attempt < 5 && !sawInvite; attempt += 1) {
      B = await reloadShell(browserB);
      sawInvite = await inviteVisible();
    }
    expect(sawInvite).toBe(true);

    await B.click('Accept');

    // Confirm the accept actually registered before reloading. Accept kicks off
    // a scoped sync that joins B to the share's collections; reloading before it
    // lands discards the pending action and B never joins (ends up with only its
    // own vault). The bundle's pending title clearing is the signal it took.
    const pendingTitle = `${accounts.sender.username} wants to share a folder with you`;
    await browserB.waitUntil(
      async () => !(await B.isDisplayed(pendingTitle, 500)),
      {
        timeout: 60_000,
        timeoutMsg: 'share bundle did not clear after Accept'
      }
    );
    B = await reloadShell(browserB);

    // Drive re-syncs until the shared content (with A1's pre-share edit) lands in
    // B's store, rather than trusting a single post-accept sync under load.
    const received = await syncUntil(
      browserB,
      () => noteBodyContains(browserB, sharedNoteId, PRE_SHARE_EDIT),
      { source: browserA1, rounds: 12 }
    );
    expect(received).toBe(true);

    await selectTreeSource(browserB, 'Shared');
    await B.treeItem(SHARED_FOLDER).waitForDisplayed({ timeout: 30_000 });
    await B.click(SHARED_FOLDER);
    await B.treeItem(NOTE_TITLE).waitForDisplayed({ timeout: 30_000 });
    await expectNoteBodyContains(browserB, sharedNoteId, INITIAL_BODY);
    await expectNoteBodyContains(browserB, sharedNoteId, PRE_SHARE_EDIT);
  });

  // --- 4.9 Offline folder rename survives a re-home (docs/e2e/flows.md §4.9) ---
  it("A1's unpushed folder rename survives the re-home into a scope", async () => {
    // A fresh folder pushed to the vault, then renamed locally and NOT re-synced
    // — the same "unpushed at share time" precondition the offline case needs
    // (no true network-offline toggle exists yet, see the note on the 4.8 `it`).
    // Sharing it re-homes the subtree into a scope (migrate_subtree_into_scope
    // clears the vault etebase_uid + tombstones the old row). The risk this
    // guards: the rename is a dirty last-write-wins metadata change, so the
    // re-home + scope push must KEEP the new name, not revert to the server's
    // pre-rename copy (nor resurrect an orphan vault folder under the old name).
    const RENAME_ORIG = `Rename Origin ${RUN_ID}`;
    const RENAME_NEW = `Renamed Offline ${RUN_ID}`;

    const folder = await invokeTauri<CollectionRow>(
      browserA1,
      'create_collection',
      { input: { name: RENAME_ORIG, parent_collection_id: null } }
    );
    // Push the folder to the vault under its original name first.
    await syncClient(browserA1);

    // Rename locally and DON'T sync — the rename is now dirty/unpushed.
    await invokeTauri(browserA1, 'update_collection', {
      input: { id: folder.id, name: RENAME_NEW }
    });

    // Share the (renamed) folder → re-homes it into a scope.
    await invokeTauri(browserA1, 'invite_collection', {
      input: {
        collection_id: folder.id,
        username: accounts.recipient.username,
        access_level: 'read_write'
      }
    });

    // Drive several sync rounds; the new name must hold (never flip back to the
    // pre-rename server copy) rather than trusting a single post-share sync.
    const nameHeld = await syncUntil(browserA1, async () => {
      const cols = await listCollections(browserA1);
      const row = cols.find((c) => c.id === folder.id);
      return row?.name === RENAME_NEW;
    });
    expect(nameHeld).toBe(true);

    // Exactly one folder with that id — no orphan vault copy resurrected.
    const cols = await listCollections(browserA1);
    const matches = cols.filter((c) => c.id === folder.id);
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe(RENAME_NEW);
    // And the pre-rename name is gone from the tree entirely.
    expect(cols.some((c) => c.name === RENAME_ORIG)).toBe(false);
  });
});
