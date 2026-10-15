/**
 * T3 — flow 4.13: an invite link opened outside the app.
 *
 * A link clicked in a browser reaches the app through the operating system,
 * as an address under the app's own scheme. The suite cannot click a link in
 * a browser and must not register the scheme on the machine it runs on, so it
 * hands the app the address through a test-only command that takes the same
 * path from there on: the Rust side unwraps the link and keeps it, tells the
 * window, and the window fetches it and opens the dialog.
 *
 * Nothing here needs a server. That is the point of the first test: a link
 * that arrives from outside is shown and no more, until the user goes on.
 */

import { browser, $, expect } from '@wdio/globals';
import { waitForShell } from '../../helpers/harness.js';

const SECRET = 'A'.repeat(43);
const LINK = `https://notes.example.test/join/uid1#${SECRET}`;
const OTHER_LINK = `https://notes.example.test/join/uid2#${SECRET}`;
const DIALOG = '[role="dialog"][aria-labelledby="join-link-title"]';

const addressFor = (link: string) =>
  `mindstream-notes://join?link=${encodeURIComponent(link)}`;

/** Hand the app an address the way the operating system does. Resolves to
 *  whether the app took it for an invite link. */
async function open(address: string): Promise<boolean> {
  return browser.execute(async (handed: string) => {
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
    return (await invoke('e2e_open_address', { address: handed })) === true;
  }, address);
}

async function closeDialog(): Promise<void> {
  await browser.execute((selector: string) => {
    document
      .querySelector<HTMLButtonElement>(
        `${selector} button[aria-label="Close"]`
      )
      ?.click();
  }, DIALOG);
  await $(DIALOG).waitForExist({ reverse: true, timeout: 10_000 });
}

describe('T3 an invite link opened outside the app', function () {
  beforeEach(async () => {
    await waitForShell();
  });

  it('opens the join dialog with the link filled in and looks nothing up', async () => {
    expect(await open(addressFor(LINK))).toBe(true);

    const dialog = $(DIALOG);
    await dialog.waitForDisplayed({ timeout: 30_000 });
    expect(await dialog.$('input').getValue()).toBe(LINK);

    // The link is from outside, so it is shown and no more. Looking at what
    // it leads to is the user's step: "Continue" waits, and there is no
    // preview and no error from a server nobody asked.
    const state = await browser.execute((selector: string) => {
      const box = document.querySelector(selector);
      const proceed = Array.from(box?.querySelectorAll('button') ?? []).find(
        (button) => button.textContent?.trim() === 'Continue'
      );
      return {
        canContinue: proceed !== undefined && !proceed.disabled,
        preview:
          box?.querySelector('[data-testid="join-link-preview"]') !== null,
        text: box?.textContent ?? ''
      };
    }, DIALOG);
    expect(state.canContinue).toBe(true);
    expect(state.preview).toBe(false);
    expect(state.text).not.toContain('does not work');

    await closeDialog();
  });

  it('shows a second link in place of the first', async () => {
    expect(await open(addressFor(LINK))).toBe(true);
    await $(DIALOG).waitForDisplayed({ timeout: 30_000 });

    expect(await open(addressFor(OTHER_LINK))).toBe(true);
    await browser.waitUntil(
      async () => (await $(DIALOG).$('input').getValue()) === OTHER_LINK,
      {
        timeout: 30_000,
        timeoutMsg: 'the second link did not replace the first'
      }
    );

    await closeDialog();
  });

  it('opens nothing for an address that carries no invite link', async () => {
    for (const address of [
      // A link that is not an invite link, and no link at all.
      'mindstream-notes://join?link=https%3A%2F%2Fexample.com%2F',
      'mindstream-notes://join',
      // Another action, and another app's address.
      `mindstream-notes://open?link=${encodeURIComponent(LINK)}`,
      `other-app://join?link=${encodeURIComponent(LINK)}`,
      // The bare link is for a browser. The operating system never hands
      // the app one, and it is not taken if something does.
      LINK
    ]) {
      expect(await open(address)).toBe(false);
    }
    // Long enough for a dialog to have opened if one were going to.
    await browser.pause(1_000);
    await expect($(DIALOG)).not.toBeExisting();
  });
});
