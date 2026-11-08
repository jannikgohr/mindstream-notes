import { expect, test } from '@playwright/test';
import { clickFileTreeCreateAction } from './file-tree-toolbar';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Welcome', exact: true })
  ).toBeVisible();
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

test('undoes and redoes board changes from the keyboard', async ({ page }) => {
  await clickFileTreeCreateAction(page, 'New Kanban board');
  const draft = page.getByRole('textbox', { name: 'New note' });
  await draft.fill(`Board ${Date.now()}`);
  await draft.press('Enter');
  const toolbar = page.getByRole('toolbar', { name: 'Kanban board toolbar' });
  const undo = toolbar.getByRole('button', { name: 'Undo', exact: true });
  const redo = toolbar.getByRole('button', { name: 'Redo', exact: true });
  await expect(undo).toBeDisabled();

  await page
    .getByRole('button', { name: 'Add card', exact: true })
    .first()
    .click();
  await expect(undo).toBeEnabled();
  // Leave the card editor so the keys reach the board, not a text field.
  await page.keyboard.press('Escape');
  await page.locator('body').click({ position: { x: 5, y: 5 } });

  await page.keyboard.press('Control+z');
  await expect(undo).toBeDisabled();
  await expect(redo).toBeEnabled();
  await page.keyboard.press('Control+y');
  await expect(undo).toBeEnabled();
  await expect(redo).toBeDisabled();
});

test('undo in a board text field undoes the typing, not the board', async ({
  page
}) => {
  await clickFileTreeCreateAction(page, 'New Kanban board');
  const draft = page.getByRole('textbox', { name: 'New note' });
  await draft.fill(`Board ${Date.now()}`);
  await draft.press('Enter');
  const toolbar = page.getByRole('toolbar', { name: 'Kanban board toolbar' });
  const undo = toolbar.getByRole('button', { name: 'Undo', exact: true });
  await page
    .getByRole('button', { name: 'Add card', exact: true })
    .first()
    .click();
  await expect(undo).toBeEnabled();
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+F');
  const search = page.getByPlaceholder('Search Kanban cards');
  await search.pressSequentially('abc');
  await page.keyboard.press('Control+z');

  await expect(search).not.toHaveValue('abc');
  await expect(undo).toBeEnabled();
});
