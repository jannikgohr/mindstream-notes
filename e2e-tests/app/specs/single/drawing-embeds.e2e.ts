/**
 * T3 — web embeds in a drawing canvas, under the packaged webview's CSP.
 *
 * The browser-fallback suite runs without a CSP, so only the real app shows
 * whether `frame-src` lets an embed's iframe through. The checks read the
 * webview's `securitypolicyviolation` events rather than the frame's content,
 * which keeps them independent of the network: a refused frame reports a
 * violation before any request is made.
 *
 * Embeds in a shared folder are covered in multi/sharing.e2e.ts.
 */

import { expect } from '@wdio/globals';
import {
  pasteOnCanvas,
  waitForCanvas,
  waitForEmbeds
} from '../../helpers/drawing-embeds.js';
import {
  byName,
  clickFileTreeCreateAction,
  clickName,
  pressElementKey,
  setElementValue,
  waitForShell
} from '../../helpers/harness.js';

interface Violation {
  blockedURI: string;
  directive: string;
}

async function createDrawing(title: string): Promise<void> {
  await clickFileTreeCreateAction('New drawing canvas');
  const draft = $('input[placeholder="New drawing canvas"]');
  await draft.waitForDisplayed();
  await setElementValue(draft, title);
  await pressElementKey(draft, 'Enter');
  await expect(byName(title)).toBeDisplayed();
  if (!(await $('.freeform-canvas-host .excalidraw').isDisplayed())) {
    await clickName(title);
  }
  await waitForCanvas(browser);
}

/** Record the page's CSP violations from now on, for `violations()`. */
async function recordViolations(): Promise<void> {
  await browser.execute(() => {
    const target = window as unknown as { __embedViolations?: unknown[] };
    target.__embedViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      target.__embedViolations?.push({
        blockedURI: event.blockedURI,
        directive: event.effectiveDirective || event.violatedDirective
      });
    });
  });
}

function violations(): Promise<Violation[]> {
  return browser.execute(
    () =>
      ((window as unknown as { __embedViolations?: Violation[] })
        .__embedViolations ?? []) as Violation[]
  );
}

describe('T3 drawing embeds', function () {
  beforeEach(async () => {
    await waitForShell();
  });

  it('loads https embeds in a private drawing under the app CSP', async () => {
    await createDrawing(`Embeds ${Date.now()}`);
    await recordViolations();

    // The listener has to see a refusal before its silence means anything:
    // frame-src admits https but not cleartext http.
    await browser.execute(() => {
      const frame = document.createElement('iframe');
      frame.src = 'http://embed-check.invalid/';
      document.body.append(frame);
    });
    await browser.waitUntil(
      async () =>
        (await violations()).some(
          (violation) =>
            violation.directive === 'frame-src' &&
            violation.blockedURI.startsWith('http://embed-check.invalid')
        ),
      {
        timeout: 10_000,
        timeoutMsg: 'the webview reported no CSP violation for an http frame'
      }
    );

    await pasteOnCanvas(browser, [
      'https://example.com/',
      'https://vimeo.com/76979871',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://x.com/someone/status/1'
    ]);
    const shown = await waitForEmbeds(browser, 4);

    expect(shown[0]).toMatchObject({
      kind: 'iframe',
      src: 'https://example.com/'
    });
    expect(shown[1].kind).toBe('iframe');
    expect(shown[1].src).toMatch(/^https:\/\/player\.vimeo\.com\/video\//);
    // A tauri:// app page (Linux, macOS) sends no Referer, and YouTube's
    // player refuses to play without one, so the app shows the thumbnail.
    // An http page (Windows) keeps the player.
    const protocol = await browser.execute(() => location.protocol);
    if (protocol === 'tauri:') {
      expect(shown[2].kind).toBe('placeholder');
      expect(shown[2].image).toBe(
        'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
      );
      expect(shown[2].text).toContain('Watch on YouTube');
    } else {
      expect(shown[2].kind).toBe('iframe');
      expect(shown[2].src).toMatch(/^https:\/\/www\.youtube\.com\/embed\//);
    }
    // X embeds through a script the CSP refuses, so the app says so instead.
    expect(shown[3].kind).toBe('placeholder');
    expect(shown[3].text).toContain('x.com');
    expect(shown[3].text).toContain('Open in browser');

    // Give the frames and the thumbnail time to start loading, then make
    // sure the CSP let them through. Only the deliberate http frame may have
    // been refused.
    await browser.pause(2_000);
    const refused = (await violations()).filter(
      (violation) => !violation.blockedURI.startsWith('http://embed-check')
    );
    expect(refused).toEqual([]);
  });
});
