import { expect, type Locator, type Page } from '@playwright/test';

export function modeButton(page: Page): Locator {
  return page.getByRole('button', { name: /^Editor view mode:/ });
}

/** Read CodeMirror lines without expanding blank lines through innerText. */
export async function sourceText(page: Page): Promise<string> {
  const lines = await page.locator('.cm-line').allTextContents();
  return lines.join('\n');
}

/** Cycle the editor view button until it reports the requested mode. */
export async function setMode(
  page: Page,
  target: 'WYSIWYG' | 'Source' | 'Split'
) {
  for (let i = 0; i < 4; i++) {
    const label = await modeButton(page).getAttribute('aria-label');
    if (label === `Editor view mode: ${target}`) return;
    await modeButton(page).click();
  }
  throw new Error(`could not reach view mode ${target}`);
}

export async function boot(page: Page) {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Welcome', exact: true })
  ).toBeVisible();
}
