/**
 * T3 — flow 1.1: create → edit → reopen a markdown note against the real
 * editor↔CRDT↔SQLite stack (the browser-fallback slice is
 * e2e/browser/editor-roundtrip.spec.ts). Adds the restart that only the real app can
 * prove: content written through save_note survives a quit/relaunch.
 */

import { expect } from '@wdio/globals';
import {
  byName,
  clickName,
  insertText,
  pressElementKey,
  requireAppE2E,
  restartApp,
  setElementValue,
  waitForShell
} from '../helpers/harness.js';

async function createRootNote(title: string): Promise<void> {
  await clickName('New note');
  const draft = $('input[placeholder="New note"]');
  await draft.waitForDisplayed();
  await setElementValue(draft, title);
  await pressElementKey(draft, 'Enter');
  await expect(byName(title)).toBeDisplayed();
}

describe('T3 markdown editor round-trip', function () {
  before(function () {
    requireAppE2E(this);
  });

  beforeEach(async () => {
    await waitForShell();
  });

  it('persists rich markdown across reopen and restart', async () => {
    const stamp = Date.now();
    const title = `Roundtrip ${stamp}`;
    const heading = `Project Alpha ${stamp}`;
    const body = `The quick brown fox ${stamp}.`;

    await createRootNote(title);
    await clickName(title);

    await insertText($('.ProseMirror'), `${heading}\n${body}`);

    await expect($('.ProseMirror')).toHaveText(
      expect.stringContaining(heading)
    );

    // Reopen via another note and back — proves the save_note round-trip.
    await clickName('Welcome');
    await clickName(title);
    await expect($('.ProseMirror')).toHaveText(
      expect.stringContaining(heading)
    );
    await expect($('.ProseMirror')).toHaveText(expect.stringContaining(body));

    // Restart against the same profile dir — proves on-disk persistence.
    await restartApp();
    await waitForShell();
    await clickName(title);
    await expect($('.ProseMirror')).toHaveText(
      expect.stringContaining(heading)
    );
  });
});
