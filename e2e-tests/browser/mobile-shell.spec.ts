import { expect, test } from '@playwright/test';

/**
 * The mobile shell's chrome, which follows the desktop's: the vault tile
 * opens the vault sheet, the create button makes the default kind and its
 * menu changes that default, and the note details sheet reads once.
 *
 * The mobile shell is chosen from navigator.userAgent (see lib/platform.ts).
 */

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

test.use({
  userAgent: ANDROID_UA,
  viewport: { width: 412, height: 915 },
  hasTouch: true
});

test('the vault tile opens the vault sheet', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Switch vault' }).click();
  const sheet = page.getByRole('dialog', { name: 'Vaults' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Default', { exact: true })).toBeVisible();
});

test('the create menu changes the default kind the button makes', async ({
  page
}) => {
  await page.goto('/');
  const showMenu = page.getByRole('button', {
    name: 'Show everything you can create'
  });
  await expect(
    page.getByRole('button', { name: 'New note', exact: true })
  ).toBeVisible();

  await showMenu.click();
  const menu = page.getByRole('menu', { name: 'Create' });
  await menu
    .getByRole('button', { name: 'Make New handwritten note the default' })
    .click();
  // The pinned kind moves to the top of the menu and onto the button.
  await expect(menu.getByRole('menuitem').first()).toHaveText(
    'New handwritten note'
  );
  await page.getByRole('button', { name: 'Close action menu' }).first().click();
  await expect(
    page.getByRole('button', { name: 'New handwritten note', exact: true })
  ).toBeVisible();

  // The choice is the device's toolbar order, so it survives a reload.
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'New handwritten note', exact: true })
  ).toBeVisible();
});

test('note details open as one sheet with a single heading', async ({
  page
}) => {
  await page.goto('/');
  await page
    .locator('.mobile-note-list')
    .getByRole('button', { name: /Welcome/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Show note details' }).click();
  const sheet = page.getByRole('dialog', { name: 'Note details' });
  await expect(sheet).toBeVisible();
  await expect(
    sheet.getByRole('heading', { name: 'Note details' })
  ).toHaveCount(1);
});
