import { expect, test } from '@playwright/test';

/**
 * The mobile shell's chrome, which follows the desktop's: the vault tile
 * opens the vault sheet, the create bar shows the default kind and pinned
 * kinds and its menu changes both, and the note details sheet reads once.
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

test('the create menu pins quick buttons and a hold picks the default', async ({
  page
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'New note', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'New folder', exact: true })
  ).toBeVisible();

  await page
    .getByRole('button', { name: 'Show everything you can create' })
    .click();
  const menu = page.getByRole('dialog', { name: 'Create' });
  // Pins can be many: unpinning one takes its quick button away.
  const pinFolder = menu.getByRole('button', {
    name: 'Show New folder beside the button'
  });
  await expect(pinFolder).toHaveAttribute('aria-pressed', 'true');
  await pinFolder.click();
  await expect(pinFolder).toHaveAttribute('aria-pressed', 'false');
  // Holding a type makes it the default; a toast confirms the hidden gesture.
  const ink = menu.getByRole('button', {
    name: 'New handwritten note',
    exact: true
  });
  const touch = { button: 0, pointerId: 7, pointerType: 'touch' };
  await ink.dispatchEvent('pointerdown', touch);
  await page.waitForTimeout(700);
  await ink.dispatchEvent('pointerup', touch);
  await expect(
    page.getByText('New handwritten note is now the default')
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close action menu' }).first().click();

  const main = page.getByRole('button', {
    name: 'New handwritten note',
    exact: true
  });
  await expect(main).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'New folder', exact: true })
  ).toHaveCount(0);

  // Both choices are the device's toolbar order, so they survive a reload.
  await page.reload();
  await expect(main).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'New folder', exact: true })
  ).toHaveCount(0);
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
