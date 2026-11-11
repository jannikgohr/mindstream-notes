import { expect, test, type Locator, type Page } from '@playwright/test';
import { boot } from './editor-helpers';
import {
  fileTreeCreateAction,
  openFileTreeCreateMore
} from './file-tree-toolbar';
import { treeItem } from './editor-helpers';
import { setTemplateFolder } from './template-sources';

/**
 * The plugin framework, driven through the browser-fallback SPA.
 *
 * Outside Tauri there is no backend discovery, so `loadPlugins()` registers the
 * bundled **Templates** core plugin (`com.mindstream.templates.core`) directly
 * from its manifest. That single real plugin is enough to prove the whole
 * frontend integration the unit suites can only test in isolation:
 *
 *   - its `file-tree` toolbar contribution reaches the create bar
 *     (registry → `pluginToolbarButtons` → the file-explorer menu),
 *   - the plugins settings pane lists it with its manifest metadata
 *     (`PluginsOverview` + the settings category), and
 *   - toggling the plugin's enabled switch reactively adds/removes that
 *     contribution — the `enabled` flag flowing back out to every consumer.
 *
 * The Rust discovery/signing/run-script command layer is a separate (T3)
 * concern; the mock store stands in for it here.
 */

const NEW_FROM_TEMPLATE = 'New from template';

function toolbarTemplateButton(page: Page): Locator {
  return fileTreeCreateAction(page, NEW_FROM_TEMPLATE);
}

/** Rename a tree note through its context menu. */
async function renameNote(page: Page, from: string, to: string) {
  await treeItem(page, from).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Rename/ }).click();
  // The inline field has no label of its own; it opens holding the title.
  const input = page
    .getByRole('group', { name: 'File tree' })
    .locator('input:focus');
  await expect(input).toHaveValue(from);
  await input.fill(to);
  await input.press('Enter');
  await expect(treeItem(page, to)).toBeVisible();
}

/** Open Settings and land on the Plugins category (its overview heading). */
async function openPluginsCategory(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Open settings' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // When a plugin is enabled the nav carries both the "Plugins" category and a
  // "Plugins" group header for its sub-entries; the category is the first.
  await dialog
    .getByRole('button', { name: 'Plugins', exact: true })
    .first()
    .click();
  await expect(dialog.getByRole('heading', { name: 'Plugins' })).toBeVisible();
  return dialog;
}

test.describe('plugin framework — bundled Templates plugin', () => {
  test('shows its toolbar action only while a template source has notes', async ({
    page
  }) => {
    await boot(page);
    await openFileTreeCreateMore(page);
    await expect(toolbarTemplateButton(page)).toBeHidden();
    await setTemplateFolder(page);
    await openFileTreeCreateMore(page);
    await expect(toolbarTemplateButton(page)).toBeVisible();
    await setTemplateFolder(page, null);
    await openFileTreeCreateMore(page);
    await expect(toolbarTemplateButton(page)).toBeHidden();
  });

  test('lists the plugin with its manifest metadata in settings', async ({
    page
  }) => {
    await boot(page);
    const dialog = await openPluginsCategory(page);

    // Unique strings from the manifest prove the overview card rendered.
    await expect(dialog.getByText('Version: 1.0.0')).toBeVisible();
    await expect(dialog.getByText('By Mindstream')).toBeVisible();
    await expect(
      dialog.getByText('Reusable templates from your own notes.')
    ).toBeVisible();
    await expect(
      dialog.getByRole('switch', { name: 'Enable in this vault' })
    ).toBeVisible();
  });

  test('opening the plugin settings shows its contributed section', async ({
    page
  }) => {
    await boot(page);
    const dialog = await openPluginsCategory(page);

    await dialog.getByRole('button', { name: 'Plugin settings' }).click();
    // The plugin contributes a "Template sources" section with a folder setting.
    await expect(dialog.getByText('Template folder')).toBeVisible();
  });

  test('toggling the plugin adds/removes its toolbar contribution', async ({
    page
  }) => {
    await boot(page);
    await setTemplateFolder(page);
    const templateButton = toolbarTemplateButton(page);
    await openFileTreeCreateMore(page);
    await expect(templateButton).toBeVisible();

    // Disable → the contribution and the "Plugin settings" affordance vanish.
    const dialog = await openPluginsCategory(page);
    await dialog.getByRole('switch', { name: 'Enable in this vault' }).click();
    await expect(
      dialog.getByRole('button', { name: 'Plugin settings' })
    ).toBeHidden();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await openFileTreeCreateMore(page);
    await expect(templateButton).toBeHidden();

    // Re-enable → the toolbar button comes back.
    const dialog2 = await openPluginsCategory(page);
    await dialog2.getByRole('switch', { name: 'Enable in this vault' }).click();
    await dialog2.getByRole('button', { name: 'Close' }).click();
    await openFileTreeCreateMore(page);
    await expect(templateButton).toBeVisible();
  });

  // The app runs the plugin's WebAssembly component in its backend; the
  // browser runs the TypeScript port in src/lib/plugins/browser-templates.ts.
  test('the folder menu lists template notes and creates a rendered copy', async ({
    page
  }) => {
    await boot(page);
    await treeItem(page, 'Personal').click();
    await renameNote(page, 'Ideas', 'Log {{date:YYYY}}');
    await setTemplateFolder(page);

    await treeItem(page, 'Work').click({ button: 'right' });
    const fromTemplate = page.getByRole('menuitem', {
      name: NEW_FROM_TEMPLATE,
      exact: true
    });
    await expect(fromTemplate).toHaveAttribute('aria-haspopup', 'menu');
    await fromTemplate.click();
    await page
      .getByRole('menu')
      .getByRole('menu')
      .getByRole('menuitem', { name: 'Log {{date:YYYY}}', exact: true })
      .click();

    // The copy opens with its title rendered and the template's body.
    const created = `Log ${new Date().getFullYear()}`;
    await expect(
      page.getByRole('tab', { name: created, exact: true })
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.getByRole('tabpanel', { name: created }).getByText('Backlinks panel')
    ).toBeVisible();
  });

  test('the toolbar action opens the template menu and creates a note', async ({
    page
  }) => {
    await boot(page);
    await treeItem(page, 'Personal').click();
    await setTemplateFolder(page);
    await openFileTreeCreateMore(page);
    await toolbarTemplateButton(page).click();
    await page.getByRole('menuitem', { name: 'Ideas', exact: true }).click();
    await expect(treeItem(page, 'Ideas')).toHaveCount(2);
  });

  test('template sources survive a reload', async ({ page }) => {
    await boot(page);
    await setTemplateFolder(page);
    // The settings store writes localStorage shortly after a change.
    await expect
      .poll(() =>
        page.evaluate(() =>
          localStorage.getItem('notes-app:settings:v1:vault:default')
        )
      )
      .toContain('source-folder');
    await page.reload();
    await expect(treeItem(page, 'Welcome')).toBeVisible();
    await openFileTreeCreateMore(page);
    await expect(toolbarTemplateButton(page)).toBeVisible();
  });
});
