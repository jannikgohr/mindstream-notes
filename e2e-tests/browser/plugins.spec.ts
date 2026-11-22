import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
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
 * bundled Wasm plugins, **Graph** (`com.mindstream.graph`), **Journal**
 * (`com.mindstream.journal`), **Templates**
 * (`com.mindstream.templates.core`) and **Typst** (`com.mindstream.typst`),
 * from their manifests, and the page runs their shipped components. That is enough to prove the whole frontend
 * integration the unit suites can only test in isolation:
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

/** One plugin's row in the overview, named after the plugin. */
function pluginCard(dialog: Locator, name: string): Locator {
  return dialog.getByRole('group', { name, exact: true });
}

const ENABLE = { name: 'Enable in this vault' };

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
    const card = pluginCard(await openPluginsCategory(page), 'Templates');

    // Unique strings from the manifest prove the overview card rendered.
    await expect(card.getByText('Version: 1.0.0')).toBeVisible();
    await expect(card.getByText('By Mindstream')).toBeVisible();
    await expect(
      card.getByText('Reusable templates from your own notes.')
    ).toBeVisible();
    await expect(card.getByRole('switch', ENABLE)).toBeChecked();
  });

  test('opening the plugin settings shows its contributed section', async ({
    page
  }) => {
    await boot(page);
    const dialog = await openPluginsCategory(page);

    await pluginCard(dialog, 'Templates')
      .getByRole('button', { name: 'Plugin settings' })
      .click();
    // The plugin contributes a "Template sources" section with a folder setting.
    await expect(dialog.getByText('Template folder')).toBeVisible();
    // The clicked button is gone, so focus moves to the new pane rather than
    // falling back to the search box.
    await expect(
      dialog.getByRole('region', { name: 'Templates' })
    ).toBeFocused();

    await dialog
      .getByRole('button', { name: 'Plugins', exact: true })
      .first()
      .click();
    await dialog
      .getByRole('button', { name: 'Plugin hotkeys' })
      .first()
      .click();
    await expect(
      dialog.getByRole('region', { name: 'Hotkeys', exact: true })
    ).toBeFocused();
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
    const card = pluginCard(dialog, 'Templates');
    await card.getByRole('switch', ENABLE).click();
    await expect(
      card.getByRole('button', { name: 'Plugin settings' })
    ).toBeHidden();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await openFileTreeCreateMore(page);
    await expect(templateButton).toBeHidden();

    // Re-enable → the toolbar button comes back.
    const dialog2 = await openPluginsCategory(page);
    await pluginCard(dialog2, 'Templates').getByRole('switch', ENABLE).click();
    await dialog2.getByRole('button', { name: 'Close' }).click();
    await openFileTreeCreateMore(page);
    await expect(templateButton).toBeVisible();
  });

  // The page runs the same `plugin.wasm` the app runs in its backend.
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

test.describe('plugin framework — bundled Typst plugin', () => {
  test('stays enabled across a reload and edits documents as source', async ({
    page
  }) => {
    await boot(page);
    const toggle = pluginCard(
      await openPluginsCategory(page),
      'Typst'
    ).getByRole('switch', ENABLE);
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await page.reload();
    await expect(treeItem(page, 'Welcome')).toBeVisible();

    await treeItem(page, 'Work').click({ button: 'right' });
    await page
      .getByRole('menuitem', { name: 'Typst document', exact: true })
      .click();
    await page.keyboard.type('Thesis');
    await page.keyboard.press('Enter');
    const panel = page.getByRole('tabpanel', { name: 'Thesis' });
    await expect(panel.getByText('= Thesis')).toBeVisible();
    // A browser has no typst binary to install, so it does not ask for one.
    await expect(panel.getByText(/wasn't found on PATH/)).toHaveCount(0);

    // Only the export that needs no native tool is offered, and the plugin's
    // component produces it.
    await treeItem(page, 'Thesis').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Export', exact: true }).hover();
    const exports = page.getByRole('menu').last().getByRole('menuitem');
    await expect(exports).toHaveText(['Typst source']);
    const pending = page.waitForEvent('download');
    await exports.first().click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe('Thesis.typ');
    expect(await readFile((await download.path())!, 'utf8')).toBe(
      '#set document(title: [Thesis])\n\n= Thesis\n\nStart writing in Typst here.'
    );
  });
});

test.describe('plugin framework — bundled Journal plugin', () => {
  test("opens today's daily note from its calendar", async ({ page }) => {
    await boot(page);
    const journal = page
      .getByRole('navigation')
      .getByRole('button', { name: 'Journal', exact: true });
    await journal.click();
    const view = page.locator('[data-plugin-view]');
    const today = await page.evaluate(() => {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    });
    await expect(
      view.locator(`[data-bits-day][data-value="${today}"]`)
    ).toHaveAttribute('data-selected', '');

    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await expect(
      page.getByRole('tab', { name: today, exact: true })
    ).toHaveAttribute('aria-selected', 'true');
    // The plugin redraws from the tree: the new note is listed and marked.
    await expect(
      view.getByRole('button', { name: today, exact: true })
    ).toBeVisible();

    // Clicking again opens the same note rather than a second one.
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await page
      .getByRole('navigation')
      .getByRole('button', { name: 'Home' })
      .click();
    await expect(treeItem(page, today)).toHaveCount(1);
  });
});
