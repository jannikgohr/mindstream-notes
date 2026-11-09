import { test, expect } from '../sqlite/fixtures';

// Run the production build under the same subpath as GitHub Pages. No Vite
// development server or fixture API can hide missing assets or failed saves.
test('demo notes persist through reload and reset restores the samples', async ({
  page
}) => {
  const failedAssets: string[] = [];
  page.on('response', (response) => {
    if (
      response.url().startsWith('http://localhost:1453/') &&
      response.status() >= 400
    )
      failedAssets.push(`${response.status()} ${response.url()}`);
  });
  await page.goto('./');
  if (test.info().project.name === 'webkit')
    test.skip(
      !(await page.evaluate(
        () => typeof navigator.storage?.getDirectory === 'function'
      )),
      'This WebKit has no OPFS API'
    );
  const banner = page.getByRole('complementary', { name: 'Web demo' });
  await expect(banner).toContainText('Notes stay in this browser');
  await expect(
    banner.getByRole('link', { name: 'Download the app' })
  ).toHaveAttribute(
    'href',
    'https://github.com/jannikgohr/mindstream-notes/releases/latest'
  );
  await expect(
    page.getByRole('complementary', { name: 'Browser testing' })
  ).toHaveCount(0);
  const welcome = page
    .getByRole('group', { name: 'File tree' })
    .getByRole('button', {
      name: 'Welcome',
      exact: true
    });
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  await welcome.click();
  const editor = page.locator('.ProseMirror').first();
  await expect(editor).toContainText('Welcome to Mindstream Notes');
  await editor.fill('My saved demo edit');
  // A reload immediately after typing also exercises pending-edit recovery.
  await page.reload();
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  await welcome.click();
  await expect(editor).toContainText('My saved demo edit');

  // Cancelling must leave edits intact.
  page.once('dialog', (dialog) => dialog.dismiss());
  await banner.getByRole('button', { name: 'Reset demo', exact: true }).click();
  await expect(editor).toContainText('My saved demo edit');
  page.once('dialog', (dialog) => dialog.accept());
  await Promise.all([
    page.waitForEvent('load'),
    banner.getByRole('button', { name: 'Reset demo', exact: true }).click()
  ]);
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  await welcome.click();
  await expect(editor).toContainText('Welcome to Mindstream Notes');
  await expect(editor).not.toContainText('My saved demo edit');
  await page.reload();
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  await welcome.click();
  await expect(editor).toContainText('Welcome to Mindstream Notes');
  expect(failedAssets).toEqual([]);
});

test.describe('mobile demo settings', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    viewport: { width: 412, height: 915 },
    hasTouch: true
  });

  test('account settings explain browser limitations without sign-in controls', async ({
    page
  }) => {
    await page.goto('./');
    if (test.info().project.name === 'webkit')
      test.skip(
        !(await page.evaluate(
          () => typeof navigator.storage?.getDirectory === 'function'
        )),
        'This WebKit has no OPFS API'
      );
    await expect(
      page.getByRole('complementary', { name: 'Web demo' })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByRole('button', { name: 'Account & Sync', exact: true })
      .click();
    const settings = page.getByRole('dialog', {
      name: 'Account & Sync',
      exact: true
    });
    await expect(settings).toContainText(
      'Accounts and sync are not available in the browser yet.'
    );
    await expect(settings.getByRole('textbox')).toHaveCount(0);
    await expect(settings.getByRole('radio')).toHaveCount(0);
    await expect(
      settings.getByRole('button', { name: /sign in|create account/i })
    ).toHaveCount(0);
    await settings.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: 'Appearance', exact: true })
    ).toBeVisible();
  });
});
