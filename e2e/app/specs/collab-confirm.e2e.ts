/**
 * T4 — the collab confirmation prompt before restore (docs/e2e-strategy.md §5).
 * `peerCount` is now plumbed for the awareness-based editors (markdown / PDF),
 * so with a second client present a restore must show the confirmation, and
 * solo editing must not. Ink / freeform don't report presence yet, so this also
 * asserts they do NOT prompt — pinning the documented gap.
 */

import { expect } from '@wdio/globals';

import { provisionTwoAccounts } from '../helpers/accounts.js';
import { assertBackendReady, backendUrl } from '../helpers/backend.js';
import {
  clientHelpers,
  clickLastButtonText,
  loginClient,
  requireBackendE2E,
  syncClient,
  type ClientHelpers
} from '../helpers/harness.js';

declare const browserA: WebdriverIO.Browser;
declare const browserB: WebdriverIO.Browser;

declare global {
  interface Window {
    __mindstreamE2E?: {
      notePeerCount(noteId: string): number;
    };
  }
}

interface NoteSummary {
  id: string;
  title: string;
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

async function listNotes(client: WebdriverIO.Browser): Promise<NoteSummary[]> {
  return invokeTauri<NoteSummary[]>(client, 'list_notes', {
    includeTrashed: false
  });
}

async function findNoteId(
  client: WebdriverIO.Browser,
  title: string
): Promise<string> {
  const notes = await listNotes(client);
  const note = notes.find((candidate) => candidate.title === title);
  if (!note) throw new Error(`note not found: ${title}`);
  return note.id;
}

async function notePeerCount(
  client: WebdriverIO.Browser,
  noteId: string
): Promise<number> {
  return client.execute((id: string) => {
    const e2e = window.__mindstreamE2E;
    if (!e2e) throw new Error('missing e2e diagnostics');
    return e2e.notePeerCount(id);
  }, noteId);
}

async function captureCurrentVersion(
  client: WebdriverIO.Browser,
  noteId: string
): Promise<void> {
  await invokeTauri(client, 'capture_current_note_version', {
    noteId,
    action: 'created',
    refVersionId: null
  });
}

async function waitForRestoreButtonEnabled(
  client: WebdriverIO.Browser
): Promise<void> {
  await client.waitUntil(
    () =>
      client.execute(() => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>('button')
        ).find(
          (candidate) =>
            candidate.textContent?.trim() === 'Restore this version'
        );
        return button !== undefined && !button.disabled;
      }),
    {
      timeout: 30_000,
      timeoutMsg: 'restore button did not enable'
    }
  );
}

describe('T4 collab confirmation prompt', function () {
  let A: ClientHelpers;
  let B: ClientHelpers;

  before(async function () {
    requireBackendE2E(this);
    await assertBackendReady();

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

  it('prompts on restore when a second client is present (markdown/PDF)', async function () {
    const title = `Confirm shared ${Date.now()}`;
    const changedText = `restore prompt body ${Date.now()}`;

    await A.newRootNote(title);
    await A.click(title);
    await A.insertText(browserA.$('.ProseMirror'), changedText);
    await A.click('Refresh history');

    await syncClient(browserA);
    await syncClient(browserB);

    await B.treeItem(title).waitForDisplayed({ timeout: 30_000 });
    const noteId = await findNoteId(browserA, title);
    await Promise.all([A.click(title), B.click(title)]);
    await expect(browserB.$('.ProseMirror')).toHaveText(
      expect.stringContaining(changedText)
    );
    await browserA.waitUntil(
      async () => (await notePeerCount(browserA, noteId)) > 0,
      {
        timeout: 60_000,
        timeoutMsg: 'browserA did not observe browserB as a live peer'
      }
    );

    await A.click('Note created');
    await A.click('Restore this version');

    await expect(A.byName('Restore while others are editing?')).toBeDisplayed();
    await clickLastButtonText(browserA, 'Cancel');
    await expect(
      A.byName('Restore while others are editing?')
    ).not.toBeDisplayed();

    // Canceling the collab prompt must leave the live note untouched.
    await clickLastButtonText(browserA, 'Cancel');
    await expect(browserA.$('.ProseMirror')).toHaveText(
      expect.stringContaining(changedText)
    );
  });

  it('does not prompt when editing solo', async () => {
    const title = `Confirm solo ${Date.now()}`;
    const changedText = `solo restore body ${Date.now()}`;

    await B.click('Welcome');

    await A.newRootNote(title);
    await A.click(title);
    await A.insertText(browserA.$('.ProseMirror'), changedText);
    await A.click('Refresh history');
    await A.click('Note created');
    await A.click('Restore this version');

    await expect(
      A.byName('Restore while others are editing?')
    ).not.toBeDisplayed();
    await expect(A.byName('Restored to an earlier version.')).toBeDisplayed();
  });

  it('does not prompt for ink/freeform (no presence wired yet)', async () => {
    for (const kind of ['ink', 'freeform'] as const) {
      const title = `Confirm ${kind} ${Date.now()}`;

      if (kind === 'ink') await A.newRootInk(title);
      else await A.newRootDrawing(title);

      const noteId = await findNoteId(browserA, title);
      await captureCurrentVersion(browserA, noteId);

      await syncClient(browserA);
      await syncClient(browserB);

      await B.treeItem(title).waitForDisplayed({ timeout: 30_000 });
      await Promise.all([A.click(title), B.click(title)]);

      await A.click('Refresh history');
      await A.click('Note created');
      await waitForRestoreButtonEnabled(browserA);
      await A.click('Restore this version');

      await expect(A.byName('Restore this version?')).toBeDisplayed();
      await expect(
        A.byName('Restore while others are editing?')
      ).not.toBeDisplayed();
      await clickLastButtonText(browserA, 'Restore');

      await expect(
        A.byName('Restore while others are editing?')
      ).not.toBeDisplayed();
      await expect(A.byName('Restored to an earlier version.')).toBeDisplayed();
    }
  });
});
