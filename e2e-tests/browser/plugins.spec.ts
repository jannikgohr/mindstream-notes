import { expect, test, type Locator, type Page } from '@playwright/test';

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

async function boot(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Welcome' })).toBeVisible();
}

function toolbarTemplateButton(page: Page): Locator {
  return page.getByRole('button', { name: NEW_FROM_TEMPLATE });
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
  test('contributes its file-tree toolbar button to the create bar', async ({
    page
  }) => {
    await boot(page);
    await expect(toolbarTemplateButton(page)).toBeVisible();
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
      dialog.getByRole('switch', { name: 'Enable plugin' })
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
    const templateButton = toolbarTemplateButton(page);
    await expect(templateButton).toBeVisible();

    // Disable → the contribution and the "Plugin settings" affordance vanish.
    const dialog = await openPluginsCategory(page);
    await dialog.getByRole('switch', { name: 'Enable plugin' }).click();
    await expect(
      dialog.getByRole('button', { name: 'Plugin settings' })
    ).toBeHidden();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(templateButton).toBeHidden();

    // Re-enable → the toolbar button comes back.
    const dialog2 = await openPluginsCategory(page);
    await dialog2.getByRole('switch', { name: 'Enable plugin' }).click();
    await dialog2.getByRole('button', { name: 'Close' }).click();
    await expect(templateButton).toBeVisible();
  });
});
