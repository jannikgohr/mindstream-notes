import { expect, test } from '@playwright/test';

/**
 * Create + select flows against the live tree store. Each test names its
 * note uniquely so parallel workers (each with a fresh page + fresh
 * in-memory store) never collide.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Welcome' })).toBeVisible();
});

test('creates a new note from the toolbar', async ({ page }) => {
  const title = `Note ${Date.now()}`;

  await page.getByRole('button', { name: 'New note', exact: true }).click();

  // The draft row focuses an inline rename input pre-filled "Untitled".
  const draft = page.getByRole('textbox', { name: 'New note' });
  await expect(draft).toBeFocused();
  await draft.fill(title);
  await draft.press('Enter');

  // The committed note shows up in the tree.
  await expect(
    page.getByRole('button', { name: title, exact: true })
  ).toBeVisible();
});

test('creates a new folder from the toolbar', async ({ page }) => {
  const name = `Folder ${Date.now()}`;

  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  const draft = page.getByRole('textbox', { name: 'New folder', exact: true });
  await expect(draft).toBeFocused();
  await draft.fill(name);
  await draft.press('Enter');

  await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
});

test('selects a seeded note and shows its metadata', async ({ page }) => {
  await page.getByRole('button', { name: 'Personal', exact: true }).click();
  await page.getByRole('button', { name: 'Ideas', exact: true }).click();

  // The right-hand metadata panel reflects the selected note.
  await expect(page.getByText('Markdown note')).toBeVisible();
  await expect(page.getByText('Words')).toBeVisible();
});

test('switches between desktop note sources', async ({ page }) => {
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(page.getByText('Trash is empty.')).toBeVisible();

  await page.getByRole('button', { name: 'Favourites', exact: true }).click();
  await expect(
    page.getByText('Favourite notes will appear here.')
  ).toBeVisible();
});
