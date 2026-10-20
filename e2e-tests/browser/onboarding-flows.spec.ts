import { expect, test, type Page } from '@playwright/test';
import type {
  OnboardingProgress,
  OnboardingStep
} from '../../src/lib/api/onboarding';

const setupSelector = 'main[aria-labelledby="onboarding-heading"]';

async function openFreshSetup(page: Page, step: OnboardingStep = 'account') {
  // Install once per context. Reloads must use the progress saved by the app.
  await page.addInitScript((step) => {
    if (!localStorage.getItem('mindstream:onboarding:v1'))
      localStorage.setItem(
        'mindstream:onboarding:v1',
        JSON.stringify({
          version: 1,
          id: crypto.randomUUID(),
          status: 'inProgress',
          step,
          vaultId: 'default',
          freshInstall: true
        })
      );
  }, step);
  // No launch query: fresh progress should open setup by itself.
  await page.goto('/');
  await expect(page.locator(setupSelector)).toBeVisible();
}

function progress(page: Page): Promise<OnboardingProgress> {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem('mindstream:onboarding:v1')!)
  );
}

async function expectWorkspace(page: Page) {
  await expect(page.locator(setupSelector)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Welcome', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'My first note', exact: true })
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Welcome to Mindstream', exact: true })
  ).toHaveCount(0);
}

async function rerunFromSettings(page: Page) {
  await page
    .getByRole('button', { name: 'Open settings', exact: true })
    .click();
  const settings = page.getByRole('dialog');
  await settings
    .getByRole('button', { name: 'General', exact: true })
    .first()
    .click();
  await settings
    .getByRole('button', { name: 'Run setup again', exact: true })
    .click();
  await expect(settings).toBeHidden();
  await expect(
    page.getByRole('heading', { name: 'Make yourself at home', exact: true })
  ).toBeVisible();
}

test('fresh installs open setup without a flag and require authentication for a remote account', async ({
  page
}) => {
  await openFreshSetup(page);
  const next = page.getByRole('button', { name: 'Continue', exact: true });
  await expect(
    page.getByRole('button', { name: /^On this device/ })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', { name: /^Managed hosting/ })
  ).toBeDisabled();
  await expect(
    page.getByRole('button', {
      name: 'Skip and use offline with default settings',
      exact: true
    })
  ).toBeVisible();
  await page.getByRole('button', { name: /^Your own server/ }).click();
  await expect(next).toBeDisabled();
  await page
    .getByRole('textbox', { name: 'Username', exact: true })
    .fill('onboarding-user');
  await page
    .getByLabel('Password', { exact: true })
    .fill('private-onboarding-password');
  await expect(next).toBeDisabled();
  expect(JSON.stringify(await progress(page))).not.toContain(
    'private-onboarding-password'
  );
  await page.getByRole('button', { name: /^On this device/ }).click();
  await expect(
    page.getByRole('textbox', { name: 'Username', exact: true })
  ).toHaveCount(0);
  await expect(next).toBeEnabled();
  await next.click();
  await expect(
    page.getByRole('heading', {
      name: 'Find a look that feels right',
      exact: true
    })
  ).toBeFocused();
  expect(await progress(page)).toMatchObject({
    status: 'inProgress',
    step: 'appearance',
    freshInstall: true
  });
});

for (const width of [1280, 375]) {
  test.describe(
    width === 375 ? 'mobile completion' : 'desktop completion',
    () => {
      test.use({
        viewport: { width, height: 900 },
        ...(width === 375
          ? {
              userAgent:
                'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
              hasTouch: true
            }
          : {})
      });
      test(`practice edits stay temporary when creating a blank note at ${width}px`, async ({
        page
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await openFreshSetup(page, 'editing');
        await expect(page.getByTestId('onboarding-practice')).toHaveAttribute(
          'aria-busy',
          'false'
        );
        await page.getByRole('button', { name: 'Source', exact: true }).click();
        const source = page.getByRole('textbox', {
          name: 'Practice Markdown source',
          exact: true
        });
        await source.fill(
          '# Temporary practice only\n\nDo not put this in my notes.'
        );
        if (width === 1280) {
          await page
            .getByRole('button', { name: 'Split', exact: true })
            .click();
          await expect(source).toHaveValue(/Temporary practice only/);
          await expect(
            page
              .getByTestId('onboarding-practice')
              .getByRole('heading', { name: 'Temporary practice only' })
          ).toBeVisible();
        }
        await page
          .getByRole('button', { name: 'WYSIWYG', exact: true })
          .click();
        await expect(
          page
            .getByTestId('onboarding-practice')
            .getByRole('heading', { name: 'Temporary practice only' })
        ).toBeVisible();
        await page
          .getByRole('button', { name: 'Continue', exact: true })
          .click();
        await page.getByRole('button', { name: /^A blank note/ }).click();
        await page
          .getByRole('button', { name: 'Open Mindstream', exact: true })
          .click();
        await expect(page.locator(setupSelector)).toHaveCount(0);
        expect(await progress(page)).toMatchObject({
          status: 'completed',
          step: 'start'
        });
        if (width === 1280)
          await expect(
            page.locator('.dv-active-tab').filter({ hasText: 'My first note' })
          ).toBeVisible();
        else
          await expect(
            page.locator('header').filter({ hasText: 'My first note' })
          ).toBeVisible();
        await expect(page.locator('.ProseMirror')).toBeVisible();
        await expect(page.locator('.ProseMirror')).toHaveText('');
        if (width === 375)
          await page
            .getByRole('button', { name: 'Back to notes', exact: true })
            .click();
        await page
          .getByRole('button', {
            name: width === 375 ? /^Welcome\b/ : 'Welcome',
            exact: width !== 375
          })
          .click();
        await expect(page.locator('.ProseMirror')).toContainText(
          'You are running in browser fallback mode'
        );
        await expect(page.locator('.ProseMirror')).not.toContainText(
          'Temporary practice only'
        );
      });
    }
  );
}

test('keeping the workspace preserves notes and preferences and setup can be run again', async ({
  page
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Welcome', exact: true }).click();
  const document = page.locator('.ProseMirror').first();
  await expect(document).toContainText(
    'You are running in browser fallback mode'
  );
  await document
    .locator('p')
    .first()
    .click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Saved before onboarding');
  await expect(document).toContainText('Saved before onboarding');
  const originalText = await document.innerText();
  await rerunFromSettings(page);
  await expect(
    page.getByRole('button', {
      name: 'Skip and keep current settings',
      exact: true
    })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(
    page.getByRole('button', { name: /^Open my workspace/ })
  ).toHaveAttribute('aria-pressed', 'true');
  await page
    .getByRole('button', { name: 'Open Mindstream', exact: true })
    .click();
  await expectWorkspace(page);
  await expect(document).toHaveText(originalText, { useInnerText: true });
  await expect(page.locator('html')).toHaveClass(/dark/);
  const completed = await progress(page);
  expect(completed.status).toBe('completed');
  await rerunFromSettings(page);
  expect((await progress(page)).id).not.toBe(completed.id);
  await page
    .getByRole('button', {
      name: 'Skip and keep current settings',
      exact: true
    })
    .click();
  await expectWorkspace(page);
  await expect(document).toHaveText(originalText, { useInnerText: true });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expectWorkspace(page);
  await expect(page.locator('html')).toHaveClass(/dark/);
});

for (const action of ['Import notes', 'Restore a backup']) {
  test(`${action} finishes setup and cancellation leaves the workspace usable`, async ({
    page
  }) => {
    await openFreshSetup(page, 'start');
    await page.getByRole('button', { name: action, exact: true }).click();
    if (action === 'Import notes') {
      const importer = page.getByRole('alertdialog');
      await expect(
        importer.getByRole('heading', { name: 'Import notes', exact: true })
      ).toBeVisible();
      const cancel = importer.getByRole('button', {
        name: 'Cancel',
        exact: true
      });
      await expect(cancel).toBeFocused();
      expect((await progress(page)).status).toBe('completed');
      await cancel.click();
      await expect(importer).toBeHidden();
    }
    // The browser backup picker returns null, the same result as cancellation.
    await expectWorkspace(page);
    expect((await progress(page)).status).toBe('completed');
    await page.getByRole('button', { name: 'Welcome', exact: true }).click();
    await expect(page.locator('.ProseMirror')).toContainText(
      'You are running in browser fallback mode'
    );
    await page.reload();
    await expectWorkspace(page);
  });
}

test('a damaged progress document can be repaired and retried without a reload', async ({
  page
}) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('mindstream:onboarding:v1'))
      localStorage.setItem('mindstream:onboarding:v1', '{"version":1}');
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator(setupSelector)).toHaveCount(0);
  await page.evaluate(() =>
    localStorage.setItem(
      'mindstream:onboarding:v1',
      JSON.stringify({
        version: 1,
        id: crypto.randomUUID(),
        status: 'inProgress',
        step: 'account',
        vaultId: 'default',
        freshInstall: true
      })
    )
  );
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Make yourself at home', exact: true })
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByTestId('appearance-preview')).toBeVisible();
});

test('a replaced setup session refuses stale writes and resumes after reload', async ({
  page
}) => {
  await openFreshSetup(page);
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('mindstream:onboarding:v1')!);
    localStorage.setItem(
      'mindstream:onboarding:v1',
      JSON.stringify({ ...saved, id: crypto.randomUUID() })
    );
  });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Onboarding session changed'
  );
  await expect(
    page.getByRole('heading', { name: 'Make yourself at home', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Continue', exact: true })
  ).toBeEnabled();
  expect((await progress(page)).step).toBe('account');
  await page.reload();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByTestId('appearance-preview')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
