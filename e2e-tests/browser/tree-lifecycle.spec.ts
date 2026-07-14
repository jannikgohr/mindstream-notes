import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * CI-safe tree lifecycle coverage for browser-fallback mode. These tests
 * exercise Svelte UI + the in-memory API only, so they do not require Tauri,
 * native dialogs, Docker, a local sync server, or OS-specific integration.
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

async function chooseContextItem(page: Page, item: string) {
  const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page
    .getByRole('menuitem', { name: new RegExp(`^${escaped}\\b`) })
    .click();
}

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('filters notes through the favourites source', async ({ page }) => {
  await treeItem(page, 'Welcome').click();
  await page.getByRole('button', { name: 'Add to favourites' }).last().click();

  await page.getByRole('button', { name: 'Favourites', exact: true }).click();
  await expect(treeItem(page, 'Welcome')).toBeVisible();
  await expect(treeItem(page, 'Sprint planning')).toHaveCount(0);
  await expect(treeItem(page, 'Ideas')).toHaveCount(0);

  await page
    .getByRole('button', { name: 'Remove from favourites' })
    .last()
    .click();
  await expect(
    page.getByText('Favourite notes will appear here.')
  ).toBeVisible();
});

test('moves a note to trash and restores it', async ({ page }) => {
  const title = `Trash restore ${Date.now()}`;
  await createRootNote(page, title);

  await treeItem(page, title).click({ button: 'right' });
  await chooseContextItem(page, 'Delete');
  await expect(treeItem(page, title)).toHaveCount(0);

  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(treeItem(page, title)).toBeVisible();
  await expect(
    page.getByText('This note is in the trash and is read-only.')
  ).toBeVisible();

  await treeItem(page, title).click({ button: 'right' });
  await chooseContextItem(page, 'Restore');
  await expect(treeItem(page, title)).toHaveCount(0);

  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(treeItem(page, title)).toBeVisible();
});

test('empties trash after confirmation', async ({ page }) => {
  const first = `Empty trash A ${Date.now()}`;
  const second = `Empty trash B ${Date.now()}`;
  await createRootNote(page, first);
  await createRootNote(page, second);

  for (const title of [first, second]) {
    await treeItem(page, title).click({ button: 'right' });
    await chooseContextItem(page, 'Delete');
    await expect(treeItem(page, title)).toHaveCount(0);
  }

  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(treeItem(page, first)).toBeVisible();
  await expect(treeItem(page, second)).toBeVisible();

  await page.getByRole('button', { name: 'Empty trash', exact: true }).click();
  const confirmDialog = page.getByRole('alertdialog');
  await expect(
    confirmDialog.getByRole('heading', { name: 'Empty trash', exact: true })
  ).toBeVisible();
  await confirmDialog
    .getByRole('button', { name: 'Empty trash', exact: true })
    .click();

  await expect(treeItem(page, first)).toHaveCount(0);
  await expect(treeItem(page, second)).toHaveCount(0);
  await expect(page.getByText('Trash is empty.')).toBeVisible();
});
