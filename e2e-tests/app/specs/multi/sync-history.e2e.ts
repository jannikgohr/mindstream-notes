/**
 * T4 — sync, two devices, sequential (docs/e2e/flows.md, last block).
 * Device A edits/restores → push → Device B pulls → assert the **content**
 * matches AND that B has **no `reverted` timeline entry** for A's restore.
 *
 * That negative assertion is the regression guard for the documented
 * "history is per-device, not synced" limitation
 * (docs/known-limitations.md) — the timeline is local; only content converges.
 */

import { expect } from '@wdio/globals';

import { provisionTwoAccounts } from '../../helpers/accounts.js';
import { backendUrl } from '../../helpers/backend.js';
import {
  clientHelpers,
  clickLastButtonText,
  loginClient,
  syncClient,
  waitForClientsReady,
  type ClientHelpers
} from '../../helpers/harness.js';

declare const browserA: WebdriverIO.Browser;
declare const browserB: WebdriverIO.Browser;

interface NoteRow {
  id: string;
  title: string;
  body?: string;
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

async function createNoteFixture(
  client: WebdriverIO.Browser,
  title: string,
  body: string
): Promise<NoteRow> {
  return invokeTauri<NoteRow>(client, 'create_note', {
    input: {
      title,
      body,
      parent_collection_id: null,
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

async function purgeNoteFixture(
  client: WebdriverIO.Browser,
  id: string
): Promise<void> {
  await invokeTauri(client, 'purge_note', { id });
}

/** The app's default: scheduled sync on, every 30 seconds. */
const DEFAULT_SYNC_INTERVAL_SECS = 30;

/**
 * Turn a client's background sync off or back on. Off, the device neither
 * ticks nor listens on the server's change feed, so it learns of remote
 * changes only when a test syncs it by hand. That is how a test gets a
 * device that "has not synced yet".
 */
async function setBackgroundSync(
  client: WebdriverIO.Browser,
  enabled: boolean
): Promise<void> {
  await invokeTauri(client, 'set_sync_schedule', {
    enabled,
    intervalSecs: DEFAULT_SYNC_INTERVAL_SECS
  });
}

async function noteMissingFixture(
  client: WebdriverIO.Browser,
  id: string
): Promise<boolean> {
  return client.execute(async (noteId: string) => {
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
    try {
      await invoke('load_note', { id: noteId });
      return false;
    } catch {
      return true;
    }
  }, id);
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

async function expectNoteMissing(
  client: WebdriverIO.Browser,
  noteId: string
): Promise<void> {
  await client.waitUntil(async () => noteMissingFixture(client, noteId), {
    timeout: 60_000,
    timeoutMsg: `note ${noteId} was still present`
  });
}

describe('T4 per-device history (sync negative assertion)', function () {
  let A: ClientHelpers;
  let B: ClientHelpers;

  before(async function () {
    await waitForClientsReady({ browserA, browserB });

    const server = backendUrl();
    const accounts = await provisionTwoAccounts(server);
    const sharedAccount = accounts.sender;

    await loginClient(browserA, {
      serverUrl: server,
      username: sharedAccount.username,
      password: sharedAccount.password
    });
    await loginClient(browserB, {
      serverUrl: server,
      username: sharedAccount.username,
      password: sharedAccount.password
    });

    A = clientHelpers(browserA);
    B = clientHelpers(browserB);
  });

  it('B converges on content but has no reverted entry for A’s restore', async () => {
    const title = `Sync history ${Date.now()}`;
    const changedText = `changed before restore ${Date.now()}`;

    await A.newRootNote(title);
    await A.click(title);
    await A.insertText(browserA.$('.ProseMirror'), changedText);
    await A.click('Refresh history');
    await expect(browserA.$('.ProseMirror')).toHaveText(
      expect.stringContaining(changedText)
    );

    await syncClient(browserA);
    await syncClient(browserB);

    await B.treeItem(title).waitForDisplayed({ timeout: 30_000 });
    await B.click(title);
    await expect(browserB.$('.ProseMirror')).toHaveText(
      expect.stringContaining(changedText)
    );

    // Unmount B's editor before A restores so this remains a sequential
    // push/pull sync test, not the live-collab propagation path.
    await B.click('Welcome');

    await A.click('Note created');
    await A.click('Restore this version');
    await browserA.waitUntil(
      async () =>
        (await A.isDisplayed('Restored to an earlier version.', 500)) ||
        (await A.isDisplayed('Restore while others are editing?', 500)),
      {
        timeout: 30_000,
        timeoutMsg: 'restore did not complete or show the collab prompt'
      }
    );
    if (await A.isDisplayed('Restore while others are editing?', 500)) {
      // B has navigated away from the note, but awareness can lag briefly. The
      // prompt behavior is covered in collab-confirm; this spec cares about the
      // sequential sync result and remote history staying device-local.
      await clickLastButtonText(browserA, 'Restore');
    }
    await expect(A.byName('Restored to an earlier version.')).toBeDisplayed();
    const restoredText = await browserA.$('.ProseMirror').getText();

    await syncClient(browserA);
    await syncClient(browserB);

    await B.click(title);
    await browserB.waitUntil(
      async () => {
        const text = await browserB.$('.ProseMirror').getText();
        return text === restoredText && !text.includes(changedText);
      },
      {
        timeout: 30_000,
        timeoutMsg: 'browserB did not converge on browserA restored content'
      }
    );

    await expect(
      B.byName('Restored to an earlier version.')
    ).not.toBeDisplayed();
    await expect(
      browserB.$(
        '//*[contains(normalize-space(.), "Reverted to version from")]'
      )
    ).not.toBeDisplayed();
  });

  it('keeps an unpushed local edit over a remote delete', async () => {
    const dirtyTitle = `Edit wins ${Date.now()}`;
    const baseline = `baseline ${Date.now()}`;
    const localEdit = `local edit survives ${Date.now()}`;

    const dirtyNote = await createNoteFixture(browserA, dirtyTitle, baseline);
    await syncClient(browserA);
    await syncClient(browserB);
    await expectNoteBodyContains(browserB, dirtyNote.id, baseline);

    // The scenario needs A to edit a note it does not yet know was deleted.
    // Left alone, A hears of B's delete over the change feed and pulls it
    // within a second, so there would be nothing left to edit. Hold A's
    // background sync until the test syncs it by hand.
    await setBackgroundSync(browserA, false);
    try {
      await purgeNoteFixture(browserB, dirtyNote.id);
      await syncClient(browserB);

      await saveNoteBodyFixture(browserA, dirtyNote.id, localEdit);
      await expectNoteBodyContains(browserA, dirtyNote.id, localEdit);

      await syncClient(browserA);
      await expectNoteBodyContains(browserA, dirtyNote.id, localEdit);
    } finally {
      await setBackgroundSync(browserA, true);
    }

    await syncClient(browserB);
    await expectNoteBodyContains(browserB, dirtyNote.id, localEdit);

    const cleanTitle = `Delete wins ${Date.now()}`;
    const cleanNote = await createNoteFixture(
      browserA,
      cleanTitle,
      `clean body ${Date.now()}`
    );
    await syncClient(browserA);
    await syncClient(browserB);
    await loadNoteFixture(browserB, cleanNote.id);

    await purgeNoteFixture(browserB, cleanNote.id);
    await syncClient(browserB);
    await syncClient(browserA);
    await expectNoteMissing(browserA, cleanNote.id);
  });
});
