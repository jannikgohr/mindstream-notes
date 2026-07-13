/**
 * T4 — the collaboration matrix (docs/e2e-strategy.md §4, "two clients, shared
 * note") and flow 2.5. Two app instances (two profile dirs) signed into the
 * same test account, both open on the same note in a shared collection.
 *
 * Needs the backend stack (MINDSTREAM_E2E_BACKEND=1) AND the two-client wdio
 * multiremote setup (`browserA` / `browserB`).
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

interface VersionSummary {
  id: string;
  action: 'created' | 'edited' | 'reverted';
}

interface Version extends VersionSummary {
  body: string;
}

async function listNotes(client: WebdriverIO.Browser): Promise<NoteSummary[]> {
  return client.execute(async () => {
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
    return invoke<NoteSummary[]>('list_notes', { includeTrashed: false });
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

async function waitForPeer(client: WebdriverIO.Browser, noteId: string) {
  await client.waitUntil(
    async () => (await notePeerCount(client, noteId)) > 0,
    {
      timeout: 60_000,
      timeoutMsg: 'browserA did not observe browserB as a live peer'
    }
  );
}

async function captureMarkdownVersion(
  client: WebdriverIO.Browser,
  noteId: string,
  markdown: string
): Promise<void> {
  await client.execute(
    async (id: string, snapshot: string) => {
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
      await invoke('capture_note_version', {
        noteId: id,
        noteKind: 'markdown',
        action: 'edited',
        refVersionId: null,
        markdown: snapshot
      });
    },
    noteId,
    markdown
  );
}

async function restoreLabelForSnapshot(
  client: WebdriverIO.Browser,
  noteId: string,
  snapshot: string
): Promise<'Note created' | 'Edited'> {
  const versions = await client.execute(async (id: string) => {
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
    const summaries = await invoke<VersionSummary[]>('list_note_versions', {
      noteId: id
    });
    const loaded: Version[] = [];
    for (const summary of summaries) {
      loaded.push(
        await invoke<Version>('load_note_version', { versionId: summary.id })
      );
    }
    return loaded;
  }, noteId);
  const version = versions.find((candidate) => candidate.body === snapshot);
  if (!version) throw new Error('baseline history snapshot not found');
  return version.action === 'created' ? 'Note created' : 'Edited';
}

async function prepareRestorableLiveMarkdownNote(
  A: ClientHelpers,
  B: ClientHelpers
): Promise<{
  baseText: string;
  changedText: string;
  restoreTargetLabel: 'Note created' | 'Edited';
}> {
  const title = `Collab restore ${Date.now()}`;
  const baseText = `Restore baseline ${Date.now()}`;
  const changedText = ` live change before restore ${Date.now()}`;

  await A.newRootNote(title);
  await A.click(title);
  const noteId = await findNoteId(browserA, title);
  await A.insertText(browserA.$('.ProseMirror'), baseText);
  await A.click('Refresh history');
  await captureMarkdownVersion(browserA, noteId, baseText);
  const restoreTargetLabel = await restoreLabelForSnapshot(
    browserA,
    noteId,
    baseText
  );

  await syncClient(browserA);
  await syncClient(browserB);

  await B.treeItem(title).waitForDisplayed({ timeout: 30_000 });
  await Promise.all([A.click(title), B.click(title)]);
  await expect(browserB.$('.ProseMirror')).toHaveText(
    expect.stringContaining(baseText)
  );
  await waitForPeer(browserA, noteId);

  await A.insertText(browserA.$('.ProseMirror'), changedText);
  await browserB.waitUntil(
    async () => {
      const text = await browserB.$('.ProseMirror').getText();
      return text.includes(changedText);
    },
    {
      timeout: 30_000,
      timeoutMsg: 'browserB did not receive the pre-restore live edit'
    }
  );

  return { baseText, changedText, restoreTargetLabel };
}

async function restoreFromHistoryTarget(
  A: ClientHelpers,
  restoreTargetLabel: string
): Promise<void> {
  await A.click(restoreTargetLabel);
  await A.click('Restore this version');
  await expect(A.byName('Restore while others are editing?')).toBeDisplayed();
  await clickLastButtonText(browserA, 'Restore');
}

describe('T4 collaboration matrix', function () {
  let A: ClientHelpers;
  let B: ClientHelpers;
  let noteTitle: string;
  let baselineText: string;
  let noteId: string;

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

    noteTitle = `Collab ${Date.now()}`;
    baselineText = `Baseline synced body ${Date.now()}`;

    await A.newRootNote(noteTitle);
    await A.click(noteTitle);
    await A.insertText(browserA.$('.ProseMirror'), baselineText);

    await syncClient(browserA);
    await syncClient(browserB);

    await B.treeItem(noteTitle).waitForDisplayed({ timeout: 30_000 });
    noteId = await findNoteId(browserA, noteTitle);
    await Promise.all([A.click(noteTitle), B.click(noteTitle)]);
    await expect(browserB.$('.ProseMirror')).toHaveText(
      expect.stringContaining(baselineText)
    );
    await waitForPeer(browserA, noteId);
  });

  it('edit in A propagates to B', async function () {
    const liveText = ` live edit ${Date.now()}`;

    await A.insertText(browserA.$('.ProseMirror'), liveText);

    await browserB.waitUntil(
      async () => {
        const text = await browserB.$('.ProseMirror').getText();
        return text.includes(liveText);
      },
      {
        timeout: 30_000,
        timeoutMsg: 'browserB did not receive browserA live edit'
      }
    );
  });

  it('restore in A converges B on the restored content', async function () {
    const { baseText, changedText, restoreTargetLabel } =
      await prepareRestorableLiveMarkdownNote(A, B);
    await restoreFromHistoryTarget(A, restoreTargetLabel);

    await browserB.waitUntil(
      async () => {
        const text = await browserB.$('.ProseMirror').getText();
        return text.includes(baseText) && !text.includes(changedText);
      },
      {
        timeout: 30_000,
        timeoutMsg: 'browserB did not converge on restored content'
      }
    );
  });

  it('concurrent edit survives a restore as an orphan (pins the limitation)', async function () {
    // A restores while B holds an unsynced edit → assert the DOCUMENTED merge
    // outcome (B's addition survives as an orphan; markdown merges at
    // boundaries). This guards against a *change* in the non-transactional
    // restore behaviour — see docs/known-limitations.md.
    this.skip();
  });

  it('undo of the restore in A converges B back', async function () {
    const { baseText, changedText, restoreTargetLabel } =
      await prepareRestorableLiveMarkdownNote(A, B);
    await restoreFromHistoryTarget(A, restoreTargetLabel);

    await browserB.waitUntil(
      async () => {
        const text = await browserB.$('.ProseMirror').getText();
        return text.includes(baseText) && !text.includes(changedText);
      },
      {
        timeout: 30_000,
        timeoutMsg: 'browserB did not converge before undoing the restore'
      }
    );

    await clickLastButtonText(browserA, 'Undo');

    await browserB.waitUntil(
      async () => {
        const text = await browserB.$('.ProseMirror').getText();
        return text.includes(changedText);
      },
      {
        timeout: 30_000,
        timeoutMsg: 'browserB did not converge after undoing the restore'
      }
    );
  });

  it('offline edits on both sides converge on reconnect', async function () {
    // toggle A offline, edit both, reconnect → assert convergence.
    this.skip();
  });
});
