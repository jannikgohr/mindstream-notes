import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Settings → Data & Backup: the vault importer and the legacy-link
 * conversion, driven through the browser-fallback SPA.
 *
 * The import itself runs in Rust, so this tier cannot get past picking a
 * source — outside Tauri the pickers resolve to `null`. What it does prove is
 * the wiring the unit suites cannot: the settings buttons reach their actions,
 * the lazily mounted dialog opens and closes cleanly, and a cancelled picker
 * leaves the user where they were instead of throwing. The run itself is
 * covered by the Rust suite in `src-tauri/src/import/tests.rs`.
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
