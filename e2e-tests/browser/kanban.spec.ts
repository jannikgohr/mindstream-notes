import { expect, test } from '@playwright/test';
import { clickFileTreeCreateAction } from './file-tree-toolbar';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Welcome' })).toBeVisible();
});

test('opens Kanban search from the active-note search hotkey', async ({
  page
}) => {
  const title = `Board ${Date.now()}`;

  await clickFileTreeCreateAction(page, 'New Kanban board');
  const draft = page.getByRole('textbox', { name: 'New note' });
  await expect(draft).toBeFocused();
  await draft.fill(title);
  await draft.press('Enter');

  await expect(
    page.getByRole('button', { name: title, exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('toolbar', { name: 'Kanban board toolbar' })
  ).toBeVisible();

  await page.keyboard.press('Control+F');

  await expect(page.getByPlaceholder('Search Kanban cards')).toBeVisible();
  // Scoped to the filter bar: "List" and "Priority" are ordinary words that
  // also appear in other editors' chrome elsewhere in the document.
  const filters = page.getByLabel('Kanban filters');
  await expect(filters.getByText('List', { exact: true })).toBeVisible();
  await expect(filters.getByText('Priority', { exact: true })).toBeVisible();
});
