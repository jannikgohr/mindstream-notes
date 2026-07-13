import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Tree context-menu operations in browser-fallback mode (T2): rename a note,
 * and permanently purge a single note from Trash. These complete the trash
 * lifecycle that tree-lifecycle.spec.ts starts (trash → restore → empty) by
 * adding the single-item "Delete permanently" path, plus inline rename — all
 * against the live tree store and the in-memory API.
 */

async function boot(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Welcome' })).toBeVisible();
}

function fileTree(page: Page): Locator {
  return page.getByRole('group', { name: 'File tree' });
}

function treeItem(page: Page, name: string): Locator {
  return fileTree(page).getByRole('button', { name, exact: true });
}

async function createRootNote(page: Page, title: string) {
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  const draft = page.getByRole('textbox', { name: 'New note' });
  await expect(draft).toBeFocused();
  await draft.fill(title);
  await draft.press('Enter');
  await expect(treeItem(page, title)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('renames a note from the context menu', async ({ page }) => {
  const original = `Rename me ${Date.now()}`;
  const renamed = `Renamed ${Date.now()}`;
  await createRootNote(page, original);

  await treeItem(page, original).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Rename/ }).click();

  // The inline rename input is the only textbox in the tree, pre-filled with
  // the current name.
  const input = fileTree(page).getByRole('textbox');
  await expect(input).toHaveValue(original);
  await input.fill(renamed);
  await input.press('Enter');

  await expect(treeItem(page, renamed)).toBeVisible();
  await expect(treeItem(page, original)).toHaveCount(0);
});

test('permanently deletes a single note from trash', async ({ page }) => {
  const title = `Purge me ${Date.now()}`;
  await createRootNote(page, title);

  // Trash it (direct, no confirm), then open the Trash source.
  await treeItem(page, title).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Delete\b/ }).click();
  await expect(treeItem(page, title)).toHaveCount(0);

  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(treeItem(page, title)).toBeVisible();

  // "Delete permanently" → confirm with the destructive "Delete" button.
  await treeItem(page, title).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Delete permanently/ }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete', exact: true })
    .click();

  await expect(treeItem(page, title)).toHaveCount(0);
  await expect(page.getByText('Trash is empty.')).toBeVisible();
});
