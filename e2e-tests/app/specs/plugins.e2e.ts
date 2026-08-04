/**
 * T3 — plugin framework against the real backend (Rust on-disk discovery +
 * the SQLite plugin-record table). The browser-fallback slice lives in
 * e2e-tests/browser/plugins.spec.ts, which registers the bundled Templates
 * plugin straight from its manifest (no backend). Here the value is what only
 * the packaged app can prove:
 *
 *   - `plugins_discover` reads the bundled `plugins/` dir off disk and its
 *     Templates plugin's `file-tree` toolbar contribution renders in the shell,
 *   - `plugins_set_enabled` writes the enabled flag to the plugin-record table,
 *     and discovery re-reads it — so a disable **survives an app restart**.
 *
 * The frontend integration itself (registry → menu wiring, reactive re-render)
 * is already proven in the browser slice; this spec is deliberately thin,
 * asserting only the parts that traverse the Tauri IPC boundary and SQLite.
 *
 * Run: pnpm test:e2e:app
 */

import { expect } from '@wdio/globals';
import {
  byName,
  clickName,
  restartApp,
  waitForShell
} from '../helpers/harness.js';

/** Open Settings and land on the Plugins overview. */
async function openPluginsCategory(): Promise<void> {
  await clickName('Open settings');
  // `aria/Plugins` resolves the settings category; clicking it shows the
  // PluginsOverview (whose per-plugin card carries the Enable switch).
  await clickName('Plugins');
  await expect(byName('Enable plugin')).toBeDisplayed();
}

describe('T3 plugin framework', function () {
  beforeEach(async () => {
    await waitForShell();
  });

  it('discovers the bundled Templates plugin and renders its toolbar button', async () => {
    // The "New from template" create-bar button is the Templates plugin's
    // `file-tree` toolbar contribution — its presence means `plugins_discover`
    // read the bundled dir and the app registered the enabled plugin.
    await expect(byName('New from template')).toBeDisplayed();
  });

  it('lists the plugin in the settings overview', async () => {
    await openPluginsCategory();
    await expect(byName('Enable plugin')).toBeDisplayed();
    await expect(byName('Plugin settings')).toBeDisplayed();
    await clickName('Close');
  });

  it('a disabled plugin stays disabled across a restart (plugin-record persistence)', async () => {
    await expect(byName('New from template')).toBeDisplayed();

    await openPluginsCategory();
    await clickName('Enable plugin'); // toggle off
    await clickName('Close');
    // The reactive registry drops the contribution immediately.
    await expect(byName('New from template')).not.toBeDisplayed();

    await restartApp();
    await waitForShell();

    // The disabled flag was persisted to the plugin-record table and re-read by
    // discovery on boot — the contribution is still gone, not resurrected by a
    // fresh discovery pass.
    await expect(byName('New from template')).not.toBeDisplayed();

    // Re-enable so the profile dir doesn't leak a disabled plugin into later
    // specs sharing it.
    await openPluginsCategory();
    await clickName('Enable plugin');
    await clickName('Close');
    await expect(byName('New from template')).toBeDisplayed();
  });
});
