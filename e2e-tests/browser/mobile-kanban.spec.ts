import { expect, test } from '@playwright/test';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

test.use({ userAgent: ANDROID_UA, viewport: { width: 412, height: 915 } });

test('mobile Kanban fills the viewport and exposes card actions', async ({
  page
}) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'More actions' }).last().click();
  await page.getByRole('button', { name: 'New Kanban board' }).click();
  await page.getByPlaceholder('Kanban board title').fill('Mobile board');
  await page.getByRole('button', { name: 'Create' }).click();

  const board = page.locator('.kanban-scope.mobile .wx-board');
  const column = page.locator('.kanban-scope.mobile .wx-column');
  await expect(board).toBeVisible();
  await expect(column).toBeVisible();

  const widths = await page.evaluate(() => ({
    board: document
      .querySelector('.kanban-scope.mobile .wx-board')
      ?.getBoundingClientRect().width,
    column: document
      .querySelector('.kanban-scope.mobile .wx-column')
      ?.getBoundingClientRect().width,
    viewport: window.innerWidth
  }));
  expect(widths.board).toBe(widths.viewport);
  expect(widths.column).toBe(widths.viewport);

  await page.getByRole('button', { name: 'Add card' }).click();
  await expect(page.getByTitle('Close')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Duplicate card' })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();
});
