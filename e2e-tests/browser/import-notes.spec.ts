import { expect, test, type Locator, type Page } from '@playwright/test';

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
  const settings = await openDataSettings(page);
  const trigger = settings.getByRole('button', {
    name: 'Import notes',
    exact: true
  });
  await trigger.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();

  await page.evaluate(() => {
    const host = window as unknown as {
      __TAURI_INTERNALS__?: {
        transformCallback: () => number;
        invoke: (command: string) => Promise<unknown>;
      };
    };
    host.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command) => {
        if (command.startsWith('plugin:event|')) return 1;
        if (command === 'notes_import_pick_folder') return '/test/vault';
        if (command === 'notes_import_detect') {
          return {
            path: '/test/vault',
            kind: 'obsidian',
            suggested_name: 'Vault'
          };
        }
        throw new Error(`Unexpected test IPC: ${command}`);
      }
    };
  });
  await dialog.getByRole('button', { name: /Choose a folder/ }).click();
  await expect(
    dialog.getByRole('combobox', { name: 'Format', exact: true })
  ).toHaveValue('obsidian');

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

  // A genuine close must still remove the scope and allow Settings to focus.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(
    dialog.getByRole('button', { name: /Choose a folder/ })
  ).toBeVisible();
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  await cancel.focus();
  await expect(cancel).toBeFocused();
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
