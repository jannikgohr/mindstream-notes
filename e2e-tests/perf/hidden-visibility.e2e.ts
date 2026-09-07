/**
 * Does the page know the window is gone?
 *
 * `Window::hide()` (what close-to-tray calls) and minimising both hide the
 * OS window, but neither touches `ICoreWebView2Controller::IsVisible`. If
 * the controller still says visible, Chromium never backgrounds the page:
 * `document.visibilityState` stays "visible", timers keep their full rate,
 * and the compositor keeps working — which is why a tray-parked app climbs
 * back to its full resident size.
 *
 * Now that the app sets `IsVisible` itself, this asserts the contract in
 * both directions -- including that the restored window actually paints,
 * since a webview left marked invisible under a shown window is blank.
 */

import { browser, $, expect } from '@wdio/globals';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForShell } from '../app/helpers/harness.js';

const SHOW_WINDOW = join(
  dirname(fileURLToPath(import.meta.url)),
  'show-window.ps1'
);

/** SW_MINIMIZE / SW_RESTORE against the app's own top-level window. */
function showWindow(cmd: number): void {
  execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${SHOW_WINDOW}" -Cmd ${cmd}`
  );
}

async function state(): Promise<string> {
  return browser.execute(
    () =>
      `visibilityState=${document.visibilityState} hidden=${document.hidden} hasFocus=${document.hasFocus()}`
  );
}

describe('hidden-window page visibility', function () {
  it('backgrounds the page while the window is off screen, and restores it', async function () {
    // Driven through Win32 ShowWindow, and the property under test
    // (ICoreWebView2Controller::IsVisible) is WebView2's. Other platforms
    // track window visibility themselves and have nothing to assert.
    if (process.platform !== 'win32') {
      this.skip();
      return;
    }
    await waitForShell();
    await $('.dv-tab, [data-dock-panel-id]').waitForExist({ timeout: 20_000 });

    const onScreen = await state();
    console.log(`[visibility] on screen : ${onScreen}`);
    expect(onScreen).toContain('visibilityState=visible');

    showWindow(6); // SW_MINIMIZE
    await browser.pause(4000);
    const minimised = await state();
    console.log(`[visibility] minimised : ${minimised}`);
    // The point of the whole exercise: Chromium can only background the
    // page, throttle its timers and stop compositing if it is told.
    expect(minimised).toContain('visibilityState=hidden');

    showWindow(9); // SW_RESTORE
    await browser.pause(3000);
    const restored = await state();
    console.log(`[visibility] restored  : ${restored}`);
    expect(restored).toContain('visibilityState=visible');

    // A webview left marked invisible under a shown window paints nothing,
    // which is the failure mode worth guarding: assert real, laid-out
    // content rather than just the flag we set.
    const painted = await browser.execute(() => {
      const el = document.querySelector('nav, .dv-tab, [data-dock-panel-id]');
      const r = el?.getBoundingClientRect();
      return { w: Math.round(r?.width ?? 0), h: Math.round(r?.height ?? 0) };
    });
    console.log(`[visibility] painted   : ${JSON.stringify(painted)}`);
    expect(painted.w).toBeGreaterThan(0);
    expect(painted.h).toBeGreaterThan(0);
  });
});
