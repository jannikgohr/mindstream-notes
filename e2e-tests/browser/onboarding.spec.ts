import { expect, test } from '@playwright/test';

test('normal launches skip setup, and quick start persists the skip decision', async ({
  page
}) => {
  await page.goto('/');
  await expect(page.locator('.dockview-theme-bridge').first()).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Make yourself at home' })
  ).toHaveCount(0);
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
  await page.goto('/?onboarding');
  await expect(
    page.getByRole('heading', { name: 'Make yourself at home' })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^Managed hosting/ })
  ).toBeDisabled();
  const footer = page.locator('.setup-footer');
  await expect
    .poll(async () => {
      const box = await footer.boundingBox();
      return box ? Math.round(box.y + box.height) : 0;
    })
    .toBe(page.viewportSize()!.height);
  const skip = footer.getByRole('button', {
    name: 'Skip and use offline with default settings',
    exact: true
  });
  await expect(skip).toHaveClass(/bg-secondary/);
  await expect(
    footer.getByRole('button', { name: 'Continue', exact: true })
  ).toBeVisible();
  await skip.click();
  await expect(
    page.locator('main[aria-labelledby="onboarding-heading"]')
  ).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.dockview-theme-bridge').first()).toBeVisible();
  await expect(
    page.locator('main[aria-labelledby="onboarding-heading"]')
  ).toHaveCount(0);
  await page.goto('/?onboarding');
  await expect(
    footer.getByRole('button', {
      name: 'Skip and keep current settings',
      exact: true
    })
  ).toBeVisible();
  await page.getByRole('button', { name: /^Your own server/ }).click();
  await footer
    .getByRole('button', {
      name: 'Skip and keep current settings',
      exact: true
    })
    .click();
  await expect(
    page.locator('main[aria-labelledby="onboarding-heading"]')
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem('notes-app:settings:v1:vault:default') ?? '{}'
          )['account.serverType']
      )
    )
    .toBe('self-hosted');
});

test('appearance updates live, setup resumes, and shortcuts work in the practice editor', async ({
  page
}) => {
  await page.goto('/?onboarding');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByTestId('appearance-preview')).toBeVisible();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Forest', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Forest', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue('--accent-brand')
      )
    )
    .toBe('oklch(0.72 0.1 155)');
  await page
    .getByRole('slider', { name: 'Editor font size', exact: true })
    .evaluate((input) => {
      (input as HTMLInputElement).value = '22';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  // No change/pointerup event: the preview must respond during the drag.
  await expect(page.getByTestId('preview-document')).toHaveCSS(
    'font-size',
    '22px'
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem('notes-app:settings:v1:vault:default') ?? '{}'
          )['appearance.editorFontSize']
      )
    )
    .toBe(22);
  await page.reload();
  await expect(page.getByTestId('appearance-preview')).toBeVisible();
  await expect(page.getByTestId('preview-document')).toHaveCSS(
    'font-size',
    '22px'
  );
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Keyboard shortcuts' })
    .selectOption('notion');
  await expect(
    page.getByRole('combobox', { name: 'Keyboard shortcuts' })
  ).toBeEnabled();
  await expect(page.getByText('Ctrl+Shift+1', { exact: true })).toBeVisible();
  const editor = page
    .getByTestId('onboarding-practice')
    .locator('.ProseMirror');
  await expect(page.getByTestId('onboarding-practice')).toHaveAttribute(
    'aria-busy',
    'false'
  );
  await expect(editor).toBeVisible();
  // Aim at the text rather than the center of a paragraph that can wrap at
  // larger font sizes. A click in its trailing whitespace can select a list.
  await editor
    .locator('p')
    .first()
    .click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Home');
  await page.keyboard.type('Practice: ');
  await expect(editor.locator('p').first()).toContainText('Practice:');
  await page.keyboard.press('Control+Shift+1');
  await expect(editor.locator('h1')).toHaveCount(2);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: /^A short welcome note/ }).click();
  await page
    .getByRole('button', { name: 'Open Mindstream', exact: true })
    .click();
  await expect(
    page.locator('main[aria-labelledby="onboarding-heading"]')
  ).toHaveCount(0);
  await expect(
    page.locator('.dv-active-tab').filter({ hasText: 'Welcome to Mindstream' })
  ).toBeVisible();
});

test('setup fits a narrow screen and keeps the language choice', async ({
  page
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/?onboarding');
  const footer = page.locator('.setup-footer');
  const content = page.locator('.setup-content');
  const expectBottomControls = async () => {
    await expect
      .poll(async () => {
        const box = await footer.boundingBox();
        return box ? Math.round(box.y + box.height) : 0;
      })
      .toBe(page.viewportSize()!.height);
    await expect
      .poll(() =>
        content.evaluate(
          (element) => element.scrollWidth <= element.clientWidth
        )
      )
      .toBe(true);
    await expect(
      footer.getByRole('button', { name: 'Weiter', exact: true })
    ).toBeInViewport();
  };
  const choice = await page
    .getByRole('button', { name: /^On this device/ })
    .boundingBox();
  expect(choice!.height).toBeLessThan(120);
  await page.getByRole('combobox', { name: 'Language' }).selectOption('de');
  await expect(
    page.getByRole('heading', { name: 'Richte Mindstream ein' })
  ).toBeVisible();
  await expectBottomControls();
  await expect(
    footer.getByRole('button', {
      name: 'Überspringen und aktuelle Einstellungen beibehalten',
      exact: true
    })
  ).toBeInViewport();
  const accountFooter = await footer.boundingBox();
  const accountContinue = await footer
    .getByRole('button', { name: 'Weiter', exact: true })
    .boundingBox();
  const skip = await footer.locator('.setup-skip').boundingBox();
  expect(skip!.y + skip!.height).toBeLessThan(accountContinue!.y);
  await page.getByRole('button', { name: 'Weiter', exact: true }).click();
  await expect(page.getByTestId('appearance-preview')).toBeVisible();
  await expectBottomControls();
  expect(await footer.boundingBox()).toEqual(accountFooter);
  expect(
    await footer
      .getByRole('button', { name: 'Weiter', exact: true })
      .boundingBox()
  ).toEqual(accountContinue);
  await expect(
    footer.getByRole('button', { name: 'Zurück', exact: true })
  ).toBeInViewport();
  await page.setViewportSize({ width: 320, height: 568 });
  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expectBottomControls();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Weiter', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Geteilt', exact: true })
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Schreibe, wie du es gewohnt bist' })
  ).toBeVisible();
  await expectBottomControls();
  await footer.getByRole('button', { name: 'Zurück', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Wähle dein Aussehen' })
  ).toBeVisible();
  const appearanceFooter = await footer.boundingBox();
  const back = await footer
    .getByRole('button', { name: 'Zurück', exact: true })
    .boundingBox();
  await footer.getByRole('button', { name: 'Zurück', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Richte Mindstream ein' })
  ).toBeVisible();
  expect(await footer.boundingBox()).toEqual(appearanceFooter);
  // Repeated taps where Back was must not activate Skip on the first step.
  await page.mouse.click(
    back!.x + back!.width / 2,
    back!.y + back!.height / 2,
    {
      clickCount: 3
    }
  );
  await expect(
    page.getByRole('heading', { name: 'Richte Mindstream ein' })
  ).toBeVisible();
  await expect(footer.locator('.setup-skip')).toBeVisible();
});
