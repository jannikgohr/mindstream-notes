import { expect, test, type Page } from '@playwright/test';
import { boot, treeItem } from './editor-helpers';

const tabs = (page: Page) => page.locator('.dv-tabs-container > .dv-tab');
const tab = (page: Page, title: string) =>
  tabs(page).filter({ hasText: title });
const previewTab = (page: Page, title: string) =>
  tab(page, title).locator('.preview-tab');

test.beforeEach(async ({ page }) => {
  await boot(page);
  await treeItem(page, 'Personal').click();
  await treeItem(page, 'Work').click();
});

test('a click opens a preview tab that the next click replaces', async ({
  page
}) => {
  const before = await tabs(page).count();
  await treeItem(page, 'Ideas').click();
  await expect(previewTab(page, 'Ideas')).toHaveCount(1);

  await treeItem(page, 'Sprint planning').click();
  await expect(tab(page, 'Ideas')).toHaveCount(0);
  await expect(previewTab(page, 'Sprint planning')).toHaveCount(1);
  await expect(tabs(page)).toHaveCount(before + 1);
});

test('double-clicking a note in the tree keeps its tab', async ({ page }) => {
  await treeItem(page, 'Ideas').dblclick();
  await expect(tab(page, 'Ideas')).toHaveCount(1);
  await expect(previewTab(page, 'Ideas')).toHaveCount(0);

  await treeItem(page, 'Sprint planning').click();
  await expect(tab(page, 'Ideas')).toHaveCount(1);
});

test('double-clicking a preview tab keeps it', async ({ page }) => {
  await treeItem(page, 'Ideas').click();
  await expect(previewTab(page, 'Ideas')).toHaveCount(1);
  await tab(page, 'Ideas').dblclick();
  await expect(previewTab(page, 'Ideas')).toHaveCount(0);

  await treeItem(page, 'Sprint planning').click();
  await expect(tab(page, 'Ideas')).toHaveCount(1);
});

test('editing a preview note keeps its tab', async ({ page }) => {
  await treeItem(page, 'Ideas').click();
  await expect(previewTab(page, 'Ideas')).toHaveCount(1);
  const editor = page.locator('.ProseMirror:visible');
  await editor.click();
  await page.keyboard.type(' kept');
  await expect(previewTab(page, 'Ideas')).toHaveCount(0);

  await treeItem(page, 'Sprint planning').click();
  await expect(tab(page, 'Ideas')).toHaveCount(1);
});
