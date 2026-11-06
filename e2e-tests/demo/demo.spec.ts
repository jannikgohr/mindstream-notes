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
