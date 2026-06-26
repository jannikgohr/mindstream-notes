import { expect, test } from '@playwright/test';

/**
 * Drives the search dialog end to end. The query runs through the same
 * scoring/snippet pipeline (search-matcher.ts) that the unit tests cover,
 * but here it's exercised through the real dialog component, the keyboard
 * affordances, and the live mock store.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Welcome' })).toBeVisible();
});

test('finds a seeded note by a title term and opens it', async ({ page }) => {
  await page.getByRole('button', { name: 'Search notes' }).click();

  const input = page.getByPlaceholder('Search notes');
  await expect(input).toBeVisible();
  await input.fill('Sprint');

  // The snippet preview surfaces the matching note's body.
  await expect(page.getByText('Sprint planning').first()).toBeVisible();

  // Enter opens the highlighted result and closes the dialog.
  await input.press('Enter');
  await expect(page.getByPlaceholder('Search notes')).toBeHidden();
});

test('shows nothing for a query with no matches', async ({ page }) => {
  await page.getByRole('button', { name: 'Search notes' }).click();
  const input = page.getByPlaceholder('Search notes');
  await input.fill('zzzznomatchzzzz');

  // No result row should mention any of the seeded note titles.
  await expect(page.getByText('Sprint planning')).toHaveCount(0);
  await expect(page.getByText('Ideas', { exact: true })).toHaveCount(0);
});

test('closes the search dialog with Escape', async ({ page }) => {
  await page.getByRole('button', { name: 'Search notes' }).click();
  const input = page.getByPlaceholder('Search notes');
  await expect(input).toBeVisible();
  await input.press('Escape');
  await expect(page.getByPlaceholder('Search notes')).toBeHidden();
});
