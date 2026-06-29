/**
 * T3 — flow 1.1: create → edit → reopen a markdown note against the real
 * editor↔CRDT↔SQLite stack (the browser-fallback slice is
 * e2e/editor-roundtrip.spec.ts). Adds the restart that only the real app can
 * prove: content written through save_note survives a quit/relaunch.
 */

import { browser, expect } from '@wdio/globals';
import {
  byName,
  requireAppE2E,
  restartApp,
  waitForShell
} from '../helpers/harness.js';

async function createRootNote(title: string): Promise<void> {
  await byName('New note').click();
  const draft = byName('New note'); // the inline draft textbox shares the label
  await draft.waitForDisplayed();
  await draft.setValue(title);
  await browser.keys('Enter');
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
    await byName(title).click();

    const editor = $('.ProseMirror');
    await editor.click();
    await browser.keys(`# ${heading}`.split(''));
    await browser.keys('Enter');
    await browser.keys(body.split(''));

    await expect($(`h1=${heading}`)).toBeDisplayed();

    // Reopen via another note and back — proves the save_note round-trip.
    await byName('Welcome').click();
    await byName(title).click();
    await expect($(`h1=${heading}`)).toBeDisplayed();
    await expect($('.ProseMirror')).toHaveText(expect.stringContaining(body));

    // Restart against the same profile dir — proves on-disk persistence.
    await restartApp();
    await waitForShell();
    await byName(title).click();
    await expect($(`h1=${heading}`)).toBeDisplayed();
  });
});
