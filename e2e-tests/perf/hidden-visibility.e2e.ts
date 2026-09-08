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

function runShowWindow(args: string): string {
  return execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${SHOW_WINDOW}" ${args}`
  ).toString();
}

/**
 * The pid of this spec's app, or undefined if it can't be told apart.
 *
 * The script resolves the app by process name, which only works while exactly
 * one is up — and the single-client suite runs spec files in parallel, so a
 * second app can appear at any moment. Resolving once, before touching the
 * window, and driving that pid from then on takes the race out: asking again
 * after minimising would be too late anyway, since an off-screen window's page
 * stops answering and the restore would never land.
 */
function appPid(): number | undefined {
  try {
    const pid = Number(runShowWindow('-Cmd 0 -Probe').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch (err) {
    if ((err as { status?: number }).status === 2) return undefined;
    throw err;
  }
}

/** SW_MINIMIZE / SW_RESTORE against the app's own top-level window. */
function showWindow(cmd: number, pid: number): void {
  runShowWindow(`-Cmd ${cmd} -ProcId ${pid}`);
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
    // On a full (parallel) run a second app is up and neither window can be
    // claimed by name. The probe is a manual one anyway (docs/memory.md), so
    // run it on its own: pnpm test:e2e:app --spec <this file>.
    const pid = appPid();
    if (pid === undefined) {
      console.log('[visibility] skipped   : another app instance is running');
      this.skip();
      return;
    }
    await waitForShell();
    await $('.dv-tab, [data-dock-panel-id]').waitForExist({ timeout: 20_000 });

    const onScreen = await state();
    console.log(`[visibility] on screen : ${onScreen}`);
    expect(onScreen).toContain('visibilityState=visible');

    showWindow(6, pid); // SW_MINIMIZE
    await browser.pause(4000);
    const minimised = await state();
    console.log(`[visibility] minimised : ${minimised}`);
    // The point of the whole exercise: Chromium can only background the
    // page, throttle its timers and stop compositing if it is told.
    expect(minimised).toContain('visibilityState=hidden');

    showWindow(9, pid); // SW_RESTORE
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
