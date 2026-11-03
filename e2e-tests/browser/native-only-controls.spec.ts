import { expect, test } from '@playwright/test';

/**
 * A browser tab has no tray, no window to manage and no OS to register with,
 * and it cannot open a second tab on a vault it owns. These controls could
 * only do nothing there, or show a misleading error, so it must not show them.
 * The browser also has one vault it cannot change, so vault create, rename,
 * delete and switch stay out of the switcher too.
 */

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const VAULT_MANAGEMENT_LABELS = [
  'Create vault',
  'Rename vault',
  'Delete vault'
];

test.describe('desktop shell', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: 'Welcome', exact: true })
    ).toBeVisible();
  });

  test('settings leave out what only the native app can do', async ({
    page
  }) => {
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
    await expect(
      page.getByRole('menuitem', { name: /new window/i })
    ).toHaveCount(0);

    await page.keyboard.press('Escape');
    await note.click();
    await expect(page.locator('.dv-popout-host').first()).toBeAttached();
    await expect(page.locator('.dv-popout-button')).toHaveCount(0);
  });

  test('the vault switcher shows the vault name and no management', async ({
    page
  }) => {
    const switcher = page.locator('.vault-switcher:visible');
    await expect(switcher).toHaveCount(1);
    await expect(switcher.getByText('Default', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Switch vault', exact: true })
    ).toHaveCount(0);

    await switcher.getByText('Default', { exact: true }).click();
    for (const label of VAULT_MANAGEMENT_LABELS) {
      await expect(page.getByText(label, { exact: true })).toHaveCount(0);
    }
  });
});

test.describe('mobile shell', () => {
  test.use({
    userAgent: ANDROID_UA,
    viewport: { width: 412, height: 915 },
    hasTouch: true
  });

  test('the vault sheet lists the vault and no management', async ({
    page
  }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: 'Switch vault', exact: true })
      .click();
    const sheet = page.getByRole('dialog', { name: 'Vaults' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Default', { exact: true })).toBeVisible();
    for (const label of VAULT_MANAGEMENT_LABELS) {
      await expect(sheet.getByText(label, { exact: true })).toHaveCount(0);
      await expect(
        sheet.getByRole('button', { name: label, exact: true })
      ).toHaveCount(0);
    }
  });
});
