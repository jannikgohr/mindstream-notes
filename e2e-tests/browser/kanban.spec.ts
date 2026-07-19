import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Welcome' })).toBeVisible();
});

test('opens Kanban search from the active-note search hotkey', async ({
  page
}) => {
  const title = `Board ${Date.now()}`;

  await page
    .getByRole('button', { name: 'New Kanban board', exact: true })
    .click();
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
  await expect(page.getByText('List', { exact: true })).toBeVisible();
  await expect(page.getByText('Priority', { exact: true })).toBeVisible();
});
