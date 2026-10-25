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
  closeSettingsDialog,
  clickElement,
  clickName,
  isFileTreeCreateActionDisplayed,
  openFileTreeCreateMore,
  restartApp,
  revealFileTreeCreateAction,
  setPluginEnabledByName,
  waitForShell
} from '../../helpers/harness.js';

/** The bundled plugin whose toolbar contribution this spec asserts on. */
const TEMPLATES_PLUGIN = 'Templates';

/** Open Settings and land on the Plugins overview. */
async function openPluginsCategory(): Promise<void> {
  await clickName('Open settings');
  // `aria/Plugins` resolves the settings category; clicking it shows the
  // PluginsOverview (whose per-plugin card carries the Enable switch).
  await clickName('Plugins');
  await expect(byName('Enable in this vault')).toBeDisplayed();
}

/** Use the real picker and wait for its vault setting to reach SQLite. */
async function setTemplateFolder(folder: string | null): Promise<void> {
  await openPluginsCategory();
  await clickName('Plugin settings');
  await clickElement($('button[aria-label="Template folder"]'));
  await $('[role="listbox"]').waitForDisplayed();
  await browser.execute((label) => {
    const dialog = document.querySelector('[role="dialog"]');
    const options = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []
    );
    const option = label
      ? options.find((candidate) => candidate.textContent?.trim() === label)
      : options[0];
    if (!option) throw new Error(`Template folder option missing: ${label}`);
    option.click();
  }, folder);
  await browser.waitUntil(
    () =>
      browser.execute(async (selected) => {
        const api = (
          window as unknown as {
            __TAURI_INTERNALS__: {
              invoke(
                command: string,
                args: Record<string, unknown>
              ): Promise<Record<string, unknown>>;
            };
          }
        ).__TAURI_INTERNALS__;
        const settings = await api.invoke('plugins_settings_all', {
          id: 'com.mindstream.templates.core'
        });
        return selected
          ? typeof settings['source-folder'] === 'string' &&
              settings['source-folder'] !== ''
          : !settings['source-folder'];
      }, folder),
    { timeout: 10_000, timeoutMsg: 'Template folder setting was not persisted' }
  );
  await closeSettingsDialog(browser);
}

describe('T3 plugin framework', function () {
  beforeEach(async () => {
    await waitForShell();
  });

  it('discovers Templates and shows its action only when a source has notes', async () => {
    // The "New from template" create-bar button is the Templates plugin's
    // `file-tree` toolbar contribution — its presence means `plugins_discover`
    // read the bundled dir and the app registered the enabled plugin. The
    // seeded Personal folder contains Ideas; no configured source hides it.
    await setTemplateFolder(null);
    await openFileTreeCreateMore();
    expect(await isFileTreeCreateActionDisplayed('New from template')).toBe(
      false
    );
    await setTemplateFolder('Personal');
    await revealFileTreeCreateAction('New from template');
  });

  it('runs the bundled Rust component through Tauri IPC', async () => {
    const result = await browser.execute(async () => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke(
              command: string,
              args: Record<string, unknown>
            ): Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__.invoke;
      return invoke('plugins_run_script', {
        id: 'com.mindstream.templates.core',
        export: 'renderTemplate',
        input: {
          title: 'Hello {{who|capitalize}}',
          body: '# {{title|upper}}\n{{value|trim|slug}}',
          vars: { who: 'template', value: '  Some Value  ' }
        }
      });
    });
    expect(result).toEqual({
      title: 'Hello Template',
      body: '# HELLO TEMPLATE\nsome-value'
    });
  });

  it('lists the plugin in the settings overview', async () => {
    await openPluginsCategory();
    await expect(byName('Enable in this vault')).toBeDisplayed();
    await expect(byName('Plugin settings')).toBeDisplayed();
    await closeSettingsDialog(browser);
  });

  it('a disabled plugin stays disabled across a restart (plugin-record persistence)', async () => {
    await setTemplateFolder('Personal');
    await revealFileTreeCreateAction('New from template');

    await openPluginsCategory();
    await setPluginEnabledByName(TEMPLATES_PLUGIN, false);
    await closeSettingsDialog(browser);
    // The reactive registry drops the contribution immediately.
    await openFileTreeCreateMore();
    expect(await isFileTreeCreateActionDisplayed('New from template')).toBe(
      false
    );

    await restartApp();
    await waitForShell();

    // The disabled flag was persisted to the plugin-record table and re-read by
    // discovery on boot — the contribution is still gone, not resurrected by a
    // fresh discovery pass.
    await openFileTreeCreateMore();
    expect(await isFileTreeCreateActionDisplayed('New from template')).toBe(
      false
    );

    // Re-enable so the profile dir doesn't leak a disabled plugin into later
    // specs sharing it.
    await openPluginsCategory();
    await setPluginEnabledByName(TEMPLATES_PLUGIN, true);
    await closeSettingsDialog(browser);
    await revealFileTreeCreateAction('New from template');
  });
});
