/**
 * T3 — flow 3.1 / 3.2: settings + UI preferences persist across a restart.
 * Bindings are unit-tested off-Tauri (no-op branches); the real persistence
 * through desktop_settings IPC to disk / OS is only provable by restarting.
 */

import { expect } from '@wdio/globals';
import {
  byName,
  requireAppE2E,
  restartApp,
  waitForShell
} from '../helpers/harness.js';

describe('T3 settings persistence', function () {
  before(function () {
    requireAppE2E(this);
  });

  beforeEach(async () => {
    await waitForShell();
  });

  it('remembers the colour theme across a restart (3.1)', async () => {
    // The theme button's accessible name encodes the current + next mode.
    const themeButton = $('button[aria-label^="Theme:"]');
    const before = await themeButton.getAttribute('aria-label');
    await themeButton.click();
    const after = await themeButton.getAttribute('aria-label');
    expect(after).not.toBe(before);

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
