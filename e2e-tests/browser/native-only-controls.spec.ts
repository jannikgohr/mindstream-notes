import { expect, test } from '@playwright/test';

/**
 * A browser tab has no tray, no window to manage and no OS to register with,
 * and it cannot open a second tab on a vault it owns. These controls could
 * only do nothing there, or show a misleading error, so it must not show them.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Welcome', exact: true })
  ).toBeVisible();
});

test('settings leave out what only the native app can do', async ({ page }) => {
  await page
    .getByRole('button', { name: 'Open settings', exact: true })
    .click();
  const settings = page.getByRole('dialog');
  // Each page is checked through a row that stays, so a missing label can only
  // mean the row is hidden, not that the page has not switched yet.
  const pages = [
    {
      category: /^General/,
      stays: 'Run setup again',
      hidden: [
        'Vault opening',
        'Start on login',
        'Close to system tray',
        'Start in system tray'
      ]
    },
    {
      category: /^Appearance/,
      stays: 'Mode',
      hidden: ['Use custom title bar']
    },
    {
      category: /^Hotkeys/,
      stays: 'Shortcut preset',
      hidden: ['Enable global shortcuts']
    },
    {
      category: /^Data/,
      stays: 'Empty trash now',
      hidden: ['Open data folder']
    },
    {
      category: /^About/,
      stays: 'App version',
      hidden: ['Component versions', 'Scan for updates', 'Check for updates']
    }
  ];
  for (const { category, stays, hidden } of pages) {
    await settings.getByRole('button', { name: category }).first().click();
    await expect(settings.getByText(stays).first()).toBeVisible();
    for (const label of hidden) {
      await expect(settings.getByText(label, { exact: true })).toHaveCount(0);
    }
  }
});

test('notes offer no window of their own', async ({ page }) => {
  const note = page.getByRole('button', { name: 'Welcome', exact: true });
  await note.click({ button: 'right' });
  await expect(
    page.getByRole('menuitem', { name: 'Open', exact: true })
  ).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /new window/i })).toHaveCount(
    0
  );

  await page.keyboard.press('Escape');
  await note.click();
  await expect(page.locator('.dv-popout-host').first()).toBeAttached();
  await expect(page.locator('.dv-popout-button')).toHaveCount(0);
});
