import { expect, type Locator, type Page } from '@playwright/test';
import { clickFileTreeCreateAction } from './file-tree-toolbar';

export function fileTree(page: Page): Locator {
  return page.getByRole('group', { name: 'File tree' });
}

export function treeItem(page: Page, name: string): Locator {
  return fileTree(page).getByRole('button', { name, exact: true });
}

export async function createRootNote(page: Page, title: string) {
  await clickFileTreeCreateAction(page, 'New note');
  const draft = page.getByRole('textbox', { name: 'New note' });
  await expect(draft).toBeFocused();
  await draft.fill(title);
  await draft.press('Enter');
  await expect(treeItem(page, title)).toBeVisible();
}

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
