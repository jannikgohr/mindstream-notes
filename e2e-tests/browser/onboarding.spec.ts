import { expect, test } from '@playwright/test';

for (const width of [1280, 375]) {
  test(`UI font size previews locally until slider release at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/?onboarding');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const slider = page.getByRole('slider', {
      name: 'UI font size',
      exact: true
    });
    const root = page.locator('html');
    const preview = page.getByTestId('appearance-preview');
    const bold = preview.getByRole('button', { name: 'Bold', exact: true });
    await expect(root).toHaveCSS('font-size', '16px');
    await slider.scrollIntoViewIfNeeded();
    const track = (await slider.boundingBox())!;
    const initialButton = (await bold.boundingBox())!;
    // Start at the current thumb, then move to the maximum while holding down.
    await page.mouse.move(
      track.x + 8 + ((track.width - 16) * 4) / 6,
      track.y + track.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(
      track.x + track.width - 1,
      track.y + track.height / 2
    );
    await expect(slider).toHaveValue('18');
    await expect(preview).toHaveCSS('zoom', '1.125');
    await expect(root).toHaveCSS('font-size', '16px');
    expect(await slider.boundingBox()).toEqual(track);
    expect((await bold.boundingBox())!.height).toBeCloseTo(
      (initialButton.height * 18) / 16,
      1
    );
    // UI scaling must leave the sample's independent editor text size alone.
    const editorSize = await page
      .getByTestId('preview-document')
      .evaluate(
        (element) =>
          parseFloat(getComputedStyle(element).fontSize) *
          Number(
            getComputedStyle(
              element.closest('[data-testid="appearance-preview"]')!
            ).zoom
          )
      );
    expect(editorSize).toBeCloseTo(16, 1);
    if (width === 1280)
      await page.screenshot({
        path: test.info().outputPath('ui-size-during-drag.png'),
        animations: 'disabled'
      });
    await page.mouse.up();
    await expect(root).toHaveCSS('font-size', '18px');
    await expect(preview).toHaveCSS('zoom', '1');
    // Reload verifies that the released value goes through normal persistence.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem('notes-app:settings:v1') ?? '{}')[
              'appearance.uiFontSize'
            ]
        )
      )
      .toBe(18);
    await page.reload();
    await expect(root).toHaveCSS('font-size', '18px');
    await expect(slider).toHaveValue('18');
    // Keyboard steps also commit through the native range's change event.
    await slider.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(root).toHaveCSS('font-size', '17px');
    await expect(preview).toHaveCSS('zoom', '1');
  });
}

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
  await expect(
    page.getByRole('button', { name: 'Apollo', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');
  // Preset changes must complete without touching the retired accent setting.
  // Exercise the new built-ins in both modes before resuming the flow.
  for (const mode of ['Light', 'Dark']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    for (const name of ['Slate & Indigo', 'Paper & Teal', 'Apollo']) {
      const preset = page.getByRole('button', { name, exact: true });
      await preset.click();
      await expect(preset).toHaveAttribute('aria-pressed', 'true');
      await expect(preset).toBeEnabled();
      await expect(page.getByRole('alert')).toHaveCount(0);
    }
    await expect(
      page.getByRole('button', { name: 'Continue', exact: true })
    ).toBeEnabled();
    await page.screenshot({
      path: test.info().outputPath(`appearance-${mode.toLowerCase()}.png`),
      animations: 'disabled'
    });
  }
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
  const shortcuts = page.getByRole('button', { name: 'Keyboard shortcuts' });
  await shortcuts.click();
  await expect(
    page.getByRole('option', { name: 'Notion-like', exact: true })
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('keyboard-presets-dark.png'),
    animations: 'disabled'
  });
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(shortcuts).toContainText('Notion-like');
  await expect(shortcuts).toBeEnabled();
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
    const progress = page.locator('.setup-progress');
    await expect(progress.getByRole('listitem')).toHaveCount(4);
    await expect(progress.locator('[aria-current="step"]')).toHaveCount(1);
    // The visible step label must not steal length from just one connector.
    await expect
      .poll(() =>
        progress.locator('li:not(:last-child)').evaluateAll((items) => {
          const lengths = items.map((item) =>
            parseFloat(getComputedStyle(item, '::after').width)
          );
          return Math.max(...lengths) - Math.min(...lengths);
        })
      )
      .toBeLessThan(1);
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
  await page.getByRole('button', { name: 'Language', exact: true }).click();
  await expect(page.getByRole('option', { name: 'Deutsch' })).toHaveCSS(
    'min-height',
    '44px'
  );
  await page.getByRole('option', { name: 'Deutsch' }).click();
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
  await expect(page.locator('.setup-header img')).toHaveJSProperty(
    'naturalWidth',
    64
  );
  const accountFooter = await footer.boundingBox();
  await page.screenshot({ path: test.info().outputPath('mobile-account.png') });
  const accountContinue = await footer
    .getByRole('button', { name: 'Weiter', exact: true })
    .boundingBox();
  const skip = await footer.locator('.setup-skip').boundingBox();
  const scrollArea = await content.boundingBox();
  // Skip floats above the footer and aligns with Continue's right edge.
  expect(skip!.x + skip!.width).toBeCloseTo(
    accountContinue!.x + accountContinue!.width,
    1
  );
  // Continue sits in an even gutter: the same space above, below and right
  // (the 1px top border is the footer's divider, not gutter).
  const gutter =
    accountFooter!.x +
    accountFooter!.width -
    (accountContinue!.x + accountContinue!.width);
  expect(accountContinue!.y - accountFooter!.y - 1).toBeCloseTo(gutter, 0);
  expect(
    accountFooter!.y +
      accountFooter!.height -
      (accountContinue!.y + accountContinue!.height)
  ).toBeCloseTo(gutter, 0);
  expect(accountFooter!.height).toBeLessThanOrEqual(64);
  await expect(
    page.getByRole('button', { name: 'Sprache', exact: true }).locator('svg')
  ).toHaveCount(2);
  expect(accountContinue!.height).toBeGreaterThanOrEqual(44);
  expect(skip!.y + skip!.height).toBeLessThan(accountFooter!.y);
  expect(scrollArea!.y + scrollArea!.height).toBeCloseTo(accountFooter!.y, 1);
  expect(skip!.y + skip!.height).toBeLessThan(accountContinue!.y);
  await page.getByRole('button', { name: 'Weiter', exact: true }).click();
  await expect(page.getByTestId('appearance-preview')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Schiefer & Indigo', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Papier & Petrol', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Wald', exact: true })
  ).toBeVisible();
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
