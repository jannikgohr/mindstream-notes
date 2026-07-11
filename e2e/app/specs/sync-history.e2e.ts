/**
 * T4 — sync, two devices, sequential (docs/e2e-strategy.md §4, last block).
 * Device A edits/restores → push → Device B pulls → assert the **content**
 * matches AND that B has **no `reverted` timeline entry** for A's restore.
 *
 * That negative assertion is the regression guard for the documented
 * "history is per-device, not synced" limitation
 * (docs/known-limitations.md) — the timeline is local; only content converges.
 */

import { expect } from '@wdio/globals';

import { provisionTwoAccounts } from '../helpers/accounts.js';
import { assertBackendReady, backendUrl } from '../helpers/backend.js';
import {
  clientHelpers,
  loginClient,
  requireBackendE2E,
  syncClient,
  type ClientHelpers
} from '../helpers/harness.js';

declare const browserA: WebdriverIO.Browser;
declare const browserB: WebdriverIO.Browser;

describe('T4 per-device history (sync negative assertion)', function () {
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
});
