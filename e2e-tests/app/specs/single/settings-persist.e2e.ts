/**
 * T3 — flow 3.1 / 3.2: settings + UI preferences persist across a restart.
 * Bindings are unit-tested off-Tauri (no-op branches); the real persistence
 * through desktop_settings IPC to disk / OS is only provable by restarting.
 */

import { expect } from '@wdio/globals';
import {
  clickElement,
  restartApp,
  waitForShell
} from '../../helpers/harness.js';

/** The theme mode on disk: `get_desktop_theme_mode` reads the settings file. */
function savedThemeMode(): Promise<unknown> {
  return browser.execute(() =>
    (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke(command: string): Promise<unknown> };
      }
    ).__TAURI_INTERNALS__.invoke('get_desktop_theme_mode')
  );
}

describe('T3 settings persistence', function () {
  beforeEach(async () => {
    await waitForShell();
  });

  it('remembers the colour theme across a restart (3.1)', async () => {
    // The theme button's accessible name encodes the current + next mode.
    const themeButton = $('button[aria-label^="Theme:"]');
    const before = await themeButton.getAttribute('aria-label');
    await clickElement(themeButton);
    const after = await themeButton.getAttribute('aria-label');
    expect(after).not.toBe(before);

    // The label changes before the setting is saved, and a save is two synced
    // writes (backup, then file). Restarting at once can kill the app between
    // them, which a fresh Windows build does often, so wait for the file.
    const chosen = after?.match(/^Theme: (\w+)/)?.[1].toLowerCase();
    await browser.waitUntil(async () => (await savedThemeMode()) === chosen, {
      timeout: 10_000,
      timeoutMsg: `the theme mode "${chosen}" was not saved`
    });

    await restartApp();
    await waitForShell();

    const persisted = await $('button[aria-label^="Theme:"]').getAttribute(
      'aria-label'
    );
    // The mode chosen before the restart is the one rehydrated from disk.
    expect(persisted).toBe(after);
  });

  // TODO (needs the Settings dialog selectors): extend to language = German and
  // "close to tray" per flow 3.1, and sidebar collapse / sort strategy per flow
  // 3.2 (preferences.ts debounced save → rehydrate). Drive Settings → Account /
  // Appearance and assert each survives `restartApp()`.
});
