import { expect, test } from '@playwright/test';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

test.use({ userAgent: ANDROID_UA, viewport: { width: 412, height: 915 } });

test('mobile Kanban supports list management and card actions', async ({
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

  const activeListTab = page
    .locator('.mobile-list-tabs button[data-list-id]')
    .first();
  await activeListTab.dispatchEvent('pointerdown', {
    button: 0,
    pointerId: 11,
    pointerType: 'touch',
    clientX: 72,
    clientY: 140
  });
  await page.waitForTimeout(500);

  const listManager = page.getByRole('dialog', { name: 'Manage lists' });
  await expect(listManager).toBeVisible();
  await expect(
    listManager.getByRole('button', { name: 'Rename list' })
  ).toHaveCount(3);

  const firstRow = listManager.locator('[data-manage-list-id]').first();
  await firstRow.getByRole('button', { name: 'Rename list' }).click();
  const renameInput = firstRow.getByRole('textbox', { name: 'Rename list' });
  await renameInput.fill('Cancelled rename');
  await listManager.getByRole('heading', { name: 'Manage lists' }).click();
  await expect(firstRow).toContainText('To Do');
  await expect(firstRow).not.toContainText('Cancelled rename');

  await firstRow.getByRole('button', { name: 'Rename list' }).click();
  await firstRow.getByRole('textbox', { name: 'Rename list' }).fill('Planning');
  await firstRow.getByRole('textbox', { name: 'Rename list' }).press('Enter');
  await expect(firstRow).toContainText('Planning');

  const dragHandle = firstRow.getByRole('button', { name: 'Reorder list' });
  const handleBox = await dragHandle.boundingBox();
  const lastRowBox = await listManager
    .locator('[data-manage-list-id]')
    .last()
    .boundingBox();
  expect(handleBox).not.toBeNull();
  expect(lastRowBox).not.toBeNull();
  await dragHandle.dispatchEvent('pointerdown', {
    button: 0,
    pointerId: 12,
    pointerType: 'touch',
    clientX: handleBox!.x + handleBox!.width / 2,
    clientY: handleBox!.y + handleBox!.height / 2
  });
  await expect(listManager.locator('.list-placeholder')).toBeVisible();
  await expect(listManager.locator('.drag-ghost')).toContainText('Planning');
  await page.evaluate(
    ({ x, y }) => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerId: 12,
          pointerType: 'touch',
          clientX: x,
          clientY: y
        })
      );
      window.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          pointerId: 12,
          pointerType: 'touch',
          clientX: x,
          clientY: y
        })
      );
    },
    {
      x: lastRowBox!.x + lastRowBox!.width / 2,
      y: lastRowBox!.y + lastRowBox!.height
    }
  );
  await listManager.getByRole('button', { name: 'Close' }).click();
  await expect(
    page.locator('.mobile-list-tabs > button:not(.mobile-add-list)')
  ).toHaveText(['In Progress', 'Done', 'Planning']);

  await page
    .getByRole('navigation', { name: 'Kanban lists' })
    .getByRole('button', { name: 'Done', exact: true })
    .click();
  await expect(page.locator('.mindstream-list-header .list-title')).toHaveText(
    'Done'
  );
  await expect
    .poll(() =>
      column.evaluate((element) => getComputedStyle(element).animationName)
    )
    .toContain('mobile-list-enter-previous');

  await page.getByRole('button', { name: 'Add card' }).click();
  await expect(page.getByTitle('Close')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Duplicate card' })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();
});
