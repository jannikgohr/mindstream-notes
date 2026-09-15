import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  completeImport,
  failImport,
  importRuns,
  installImportIpc
} from './import-ipc';

// Focus regressions must fail on their first attempt and leave useful evidence.
test.describe.configure({ retries: 0, timeout: 20_000 });
test.use({ trace: 'retain-on-failure', screenshot: 'only-on-failure' });

/**
 * Settings → Data & Backup: the vault importer and the legacy-link
 * conversion, driven through the browser-fallback SPA.
 *
 * A small IPC stub reaches configuration to check focus across stage changes.
 * The packaged-app and Rust suites cover the actual import and persistence.
 */

async function openDataSettings(page: Page): Promise<Locator> {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Welcome', exact: true })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open settings' }).click();
  const settings = page.getByRole('dialog');
  await expect(settings).toBeVisible();
  await settings
    .getByRole('button', { name: 'Data & Backup', exact: true })
    .first()
    .click();
  return settings;
}

async function expectFocusInside(dialog: Locator): Promise<void> {
  await expect
    .poll(() =>
      dialog.evaluate((node) => node.contains(document.activeElement))
    )
    .toBe(true);
}

async function openConfiguredImport(
  page: Page,
  instant = false
): Promise<{ settings: Locator; dialog: Locator; errors: string[] }> {
  const settings = await openDataSettings(page);
  await installImportIpc(page, instant);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await settings
    .getByRole('button', { name: 'Import notes', exact: true })
    .click();
  const dialog = page.getByRole('alertdialog');
  await expect(
    dialog.getByRole('button', { name: 'Cancel', exact: true })
  ).toBeFocused();
  await dialog.getByRole('button', { name: /Choose a folder/ }).click();
  await expect(
    dialog.getByRole('combobox', { name: 'Format', exact: true })
  ).toHaveValue('obsidian');
  await expectFocusInside(dialog);
  return { settings, dialog, errors };
}

test('Import notes opens a dialog offering a folder or a file', async ({
  page
}) => {
  const settings = await openDataSettings(page);

  await settings
    .getByRole('button', { name: 'Import notes', exact: true })
    .click();

  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('heading', { name: 'Import notes' })
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: /Choose a folder/ })
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: /Choose a file/ })
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Cancel', exact: true })
  ).toBeFocused();

  await page.keyboard.press('Tab');
  await expect
    .poll(() =>
      dialog.evaluate((node) => node.contains(document.activeElement))
    )
    .toBe(true);

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
});

test('source choices stay inside the dialog on a narrow window', async ({
  page
}) => {
  const settings = await openDataSettings(page);
  await settings
    .getByRole('button', { name: 'Import notes', exact: true })
    .click();
  await page.setViewportSize({ width: 360, height: 640 });

  const dialog = page.getByRole('alertdialog');
  const contained = await dialog.evaluate((node) => {
    const dialogRect = node.getBoundingClientRect();
    return (
      node.scrollWidth <= node.clientWidth &&
      [...node.querySelectorAll('button')].every((button) => {
        const rect = button.getBoundingClientRect();
        return rect.left >= dialogRect.left && rect.right <= dialogRect.right;
      })
    );
  });
  expect(contained).toBe(true);
});

test('a cancelled source picker keeps the dialog on its first step', async ({
  page
}) => {
  const settings = await openDataSettings(page);
  await settings
    .getByRole('button', { name: 'Import notes', exact: true })
    .click();
  const dialog = page.getByRole('alertdialog');

  // Outside Tauri the picker resolves to null, which is exactly what a user
  // dismissing the OS dialog produces. That must not close the import dialog
  // or surface an error: they may want the other button.
  await dialog.getByRole('button', { name: /Choose a folder/ }).click();

  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: /Choose a file/ })
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Import', exact: true })
  ).toHaveCount(0);
});

test('configuration fields keep focus above Settings after source detection', async ({
  page
}) => {
  const { settings, dialog, errors } = await openConfiguredImport(page);
  const trigger = settings.getByRole('button', {
    name: 'Import notes',
    exact: true
  });
  const folder = dialog.getByRole('textbox', {
    name: 'Import into a new folder called'
  });
  await folder.focus();
  await expect(folder).toBeFocused();
  await folder.fill('Imported E2E Vault');
  const links = dialog.getByRole('combobox', {
    name: "Links to notes that aren't in the import"
  });
  await links.focus();
  await expect(links).toBeFocused();
  await links.selectOption('create-placeholder');
  await expect(links).toHaveValue('create-placeholder');

  // The last and first controls must wrap without reaching Settings.
  const submit = dialog.getByRole('button', { name: 'Import', exact: true });
  await submit.focus();
  await page.keyboard.press('Tab');
  const format = dialog.getByRole('combobox', { name: 'Format', exact: true });
  await expect(format).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(submit).toBeFocused();

  // A genuine close must still remove the scope and allow Settings to focus.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(
    dialog.getByRole('button', { name: /Choose a folder/ })
  ).toBeVisible();
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toBeFocused();
  expect(errors).toEqual([]);
});

test('running, failure, and retry preserve focus and submitted choices', async ({
  page
}) => {
  const { settings, dialog, errors } = await openConfiguredImport(page);
  const trigger = settings.getByRole('button', {
    name: 'Import notes',
    exact: true
  });
  const folder = dialog.getByRole('textbox', {
    name: 'Import into a new folder called'
  });
  await folder.fill('Retry Vault');
  await dialog
    .getByRole('combobox', { name: "Links to notes that aren't in the import" })
    .selectOption('create-placeholder');
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  const stop = dialog.getByRole('button', { name: 'Stop', exact: true });
  await expect(stop).toBeVisible();
  await expectFocusInside(dialog);
  await stop.focus();
  await page.keyboard.press('Tab');
  await expect(stop).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(stop).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();

  await failImport(page);
  await expect(
    dialog.getByText('Import failed for test', { exact: true })
  ).toBeVisible();
  await expectFocusInside(dialog);
  await folder.focus();
  await expect(folder).toBeFocused();
  await expect(folder).toHaveValue('Retry Vault');
  await folder.fill('Retried Vault');
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(stop).toBeVisible();
  await completeImport(page);
  await expect(
    dialog.getByRole('heading', { name: 'Import finished' })
  ).toBeVisible();
  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  await close.focus();
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await close.click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(
    (await importRuns(page)).map((run) => ({
      folder: run.create_folder_named,
      links: run.unresolved_links
    }))
  ).toEqual([
    { folder: 'Retry Vault', links: 'create-placeholder' },
    { folder: 'Retried Vault', links: 'create-placeholder' }
  ]);
  expect(errors).toEqual([]);
});

test('an immediate import result can close and return focus to Settings', async ({
  page
}) => {
  const { settings, dialog, errors } = await openConfiguredImport(page, true);
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(
    dialog.getByRole('heading', { name: 'Import finished' })
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    settings.getByRole('button', { name: 'Import notes', exact: true })
  ).toBeFocused();
  expect(errors).toEqual([]);
});

test('Stop keeps the running dialog open until the partial report arrives', async ({
  page
}) => {
  const { settings, dialog, errors } = await openConfiguredImport(page);
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  const stop = dialog.getByRole('button', { name: 'Stop', exact: true });
  await stop.click();
  await expect(stop).toBeDisabled();
  await expect(dialog).toBeVisible();
  await completeImport(page, true);
  await expect(
    dialog.getByRole('heading', { name: 'Import stopped' })
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    settings.getByRole('button', { name: 'Import notes', exact: true })
  ).toBeFocused();
  expect(errors).toEqual([]);
});

test('Convert legacy links says when there is nothing to convert', async ({
  page
}) => {
  const settings = await openDataSettings(page);

  await settings
    .getByRole('button', { name: 'Convert legacy links', exact: true })
    .click();

  // The browser fallback reports no [[Title]] links, so the action stops at
  // the "nothing to do" notice rather than asking to rewrite anything.
  const notice = page.getByRole('alertdialog');
  await expect(notice.getByText('Nothing to convert')).toBeVisible();
});
