import { expect, test } from '@playwright/test';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

test.use({
  userAgent: ANDROID_UA,
  viewport: { width: 412, height: 915 },
  hasTouch: true
});

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
  const exitingList = page.locator('.mobile-list-transition-ghost');
  await expect(exitingList).toBeVisible();
  await expect
    .poll(() =>
      exitingList.evaluate((element) => getComputedStyle(element).animationName)
    )
    .toContain('mobile-list-exit-previous');
  await expect(
    page.locator(
      '.wx-column:not(.mobile-list-transition-ghost) .mindstream-list-header .list-title'
    )
  ).toHaveText('Done');
  await expect
    .poll(() =>
      page
        .locator('.wx-column:not(.mobile-list-transition-ghost)')
        .evaluate((element) => getComputedStyle(element).animationName)
    )
    .toContain('mobile-list-enter-previous');
  await expect(exitingList).toBeHidden();

  await page.getByRole('button', { name: 'Add card' }).click();
  await expect(page.getByTitle('Close')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Duplicate card' })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();

  await page.getByTitle('Close').click();
  await page.getByRole('button', { name: 'Add card' }).click();
  await page.getByTitle('Close').click();

  const cardRows = page.locator(
    '.kanban-scope.mobile .wx-column:not(.mobile-list-transition-ghost) .wx-card-row'
  );
  await expect(cardRows).toHaveCount(2);
  const initialCardOrder = await cardRows.evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-kanban-card-id'))
  );

  const cardBody = page.locator('.wx-card .kanban-card-body').first();
  await expect(cardBody).toBeVisible();
  await expect
    .poll(() =>
      cardBody.evaluate(
        (element) =>
          getComputedStyle(element.closest('.wx-card') as HTMLElement)
            .touchAction
      )
    )
    .toBe('none');
  const cardBodyBox = await cardBody.boundingBox();
  expect(cardBodyBox).not.toBeNull();

  const holdX = cardBodyBox!.x + cardBodyBox!.width / 2;
  const holdY = cardBodyBox!.y + cardBodyBox!.height / 2;
  await page.mouse.move(holdX, holdY);
  await page.mouse.down();
  await page.waitForTimeout(320);
  await expect(page.locator('.wx-ghost')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('.wx-ghost')).toBeHidden();
  await expect
    .poll(() =>
      cardRows.evaluateAll((rows) =>
        rows.map((row) => row.getAttribute('data-kanban-card-id'))
      )
    )
    .toEqual(initialCardOrder);

  await cardBody.dispatchEvent('pointerdown', {
    button: 0,
    pointerId: 20,
    pointerType: 'touch',
    clientX: cardBodyBox!.x + cardBodyBox!.width / 2,
    clientY: cardBodyBox!.y + cardBodyBox!.height / 2
  });
  await page.evaluate(({ x, y }) => {
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 20,
        pointerType: 'touch',
        clientX: x,
        clientY: y + 12
      })
    );
  }, cardBodyBox!);
  await expect(page.locator('.wx-ghost')).toBeHidden();

  const contextMenuPrevented = await cardBody.evaluate((element) => {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(contextMenuPrevented).toBe(true);

  const mouseX = cardBodyBox!.x + cardBodyBox!.width / 2;
  const mouseY = cardBodyBox!.y + cardBodyBox!.height / 2;
  await page.mouse.move(mouseX, mouseY);
  await page.mouse.down();
  await page.waitForTimeout(320);
  const mouseGhost = page.locator('.wx-ghost');
  await expect(mouseGhost).toBeVisible();
  const initialGhostTransform = await mouseGhost.getAttribute('style');
  await page.mouse.move(mouseX + 24, mouseY + 24, { steps: 4 });
  await expect
    .poll(() => mouseGhost.getAttribute('style'))
    .not.toBe(initialGhostTransform);
  await page.keyboard.press('Escape');
  await expect(mouseGhost).toBeHidden();
  await page.mouse.up();

  const bottomCardBody = cardRows.last().locator('.kanban-card-body');
  const bottomCardBox = await bottomCardBody.boundingBox();
  expect(bottomCardBox).not.toBeNull();
  const touchX = bottomCardBox!.x + bottomCardBox!.width / 2;
  const touchY = bottomCardBox!.y + bottomCardBox!.height / 2;
  await bottomCardBody.dispatchEvent('pointerdown', {
    button: 0,
    pointerId: 21,
    pointerType: 'touch',
    clientX: touchX,
    clientY: touchY
  });
  await page.waitForTimeout(320);
  const touchGhost = page.locator('.wx-ghost');
  await expect(touchGhost).toBeVisible();
  const initialTouchGhostTransform = await touchGhost.getAttribute('style');
  await page.evaluate(
    ({ x, y }) => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerId: 21,
          pointerType: 'touch',
          clientX: x,
          clientY: y - 12
        })
      );
    },
    { x: touchX, y: touchY }
  );
  await expect(touchGhost).toBeVisible();
  await expect
    .poll(() => touchGhost.getAttribute('style'))
    .not.toBe(initialTouchGhostTransform);
  await page.evaluate(() => {
    window.dispatchEvent(
      new PointerEvent('pointercancel', {
        bubbles: true,
        pointerId: 21,
        pointerType: 'touch'
      })
    );
  });
  await expect(touchGhost).toBeHidden();
});
