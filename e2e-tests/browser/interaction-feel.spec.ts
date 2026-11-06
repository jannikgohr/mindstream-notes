import { expect, test, type Page } from '@playwright/test';
import { clickFileTreeCreateAction } from './file-tree-toolbar';

/**
 * Interaction details that only show up in a real browser: Excalidraw's laser
 * trail stays inside its canvas, a context submenu survives a diagonal reach
 * across its siblings, tooltips skip their delay once one has shown, and a
 * flick on a mobile Kanban card keeps coasting after the finger lifts.
 */

async function boot(page: Page) {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Welcome', exact: true })
  ).toBeVisible();
}

async function createNote(page: Page, action: string, title: string) {
  await clickFileTreeCreateAction(page, action);
  const draft = page.getByRole('textbox', { name: action, exact: true });
  await draft.fill(title);
  await draft.press('Enter');
  const item = page
    .getByRole('group', { name: 'File tree' })
    .getByRole('button', { name: title, exact: true });
  await item.click();
  return item;
}

test('laser trail stays inside the canvas', async ({ page }) => {
  await boot(page);
  await createNote(page, 'New drawing canvas', 'Laser trail');
  const host = page.locator('.freeform-canvas-host');
  await expect(page.locator('.excalidraw')).toBeVisible();
  const box = (await host.boundingBox())!;
  await page.locator('canvas.interactive').click({
    position: { x: 200, y: 200 }
  });
  await page.keyboard.press('k');
  // Drag the laser from the canvas across the sidebar to its left. The trail
  // is Excalidraw's default red; none of it may paint outside the host.
  const sx = box.x + 150;
  const sy = box.y + box.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 0; i <= 30; i++) {
    await page.mouse.move(sx - (i * (sx - 20)) / 30, sy + i);
  }
  const shot = await page.screenshot();
  await page.mouse.up();
  const counts = await page.evaluate(
    async ({ data, hostLeft }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, c.width, c.height).data;
      let inside = 0;
      let outside = 0;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          const red = px[i] > 200 && px[i + 1] < 80 && px[i + 2] < 80;
          if (!red) continue;
          if (x >= hostLeft) inside++;
          else outside++;
        }
      }
      return { inside, outside };
    },
    { data: shot.toString('base64'), hostLeft: Math.ceil(box.x) }
  );
  expect(counts.inside).toBeGreaterThan(20);
  expect(counts.outside).toBe(0);
});

test('export submenu survives a diagonal reach', async ({ page }) => {
  await boot(page);
  const item = await createNote(page, 'New note', 'Submenu reach');
  await item.click({ button: 'right' });
  const exportItem = page.getByRole('menuitem', { name: /^Export/ });
  const eb = (await exportItem.boundingBox())!;
  await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2, {
    steps: 4
  });
  const submenu = page.locator('[role="menu"] [role="menu"]');
  await expect(submenu).toBeVisible();
  const sb = (await submenu.boundingBox())!;
  // Head for the submenu's lower half, crossing the items below Export.
  const tx = sb.x + 10;
  const ty = sb.y + sb.height - 6;
  const fx = eb.x + eb.width / 2;
  const fy = eb.y + eb.height / 2;
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(fx + ((tx - fx) * i) / 12, fy + ((ty - fy) * i) / 12);
    await expect(submenu).toBeVisible();
  }
  // Resting on a sibling hands over to it.
  await page.mouse.move(fx, fy + 3 * eb.height, { steps: 2 });
  await page.waitForTimeout(400);
  await expect(submenu).toBeHidden();
});

test('tooltips warm up across neighbouring buttons', async ({ page }) => {
  await boot(page);
  const toolbar = page.getByRole('complementary').first();
  const a = toolbar.getByRole('button', { name: 'New note', exact: true });
  const more = toolbar.getByRole('button', {
    name: 'More actions',
    exact: true
  });
  const tip = page.locator('.ms-tooltip');
  await a.hover();
  await page.waitForTimeout(150);
  await expect(tip).toHaveCount(0);
  await page.waitForTimeout(350);
  await expect(tip).toHaveCount(1);
  await more.hover();
  await page.waitForTimeout(40);
  expect(await tip.allTextContents()).toEqual(['More actions']);
  await page.mouse.move(600, 600);
  await page.waitForTimeout(800);
  await a.hover();
  await page.waitForTimeout(100);
  await expect(tip).toHaveCount(0);
});

test.describe('mobile', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    viewport: { width: 412, height: 915 },
    hasTouch: true
  });

  test('a card flick keeps scrolling after release', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: 'Show everything you can create' })
      .click();
    await page
      .getByRole('dialog', { name: 'Create' })
      .getByRole('button', { name: 'New Kanban board', exact: true })
      .click();
    await page.getByPlaceholder('Kanban board title').fill('Flick board');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.locator('.kanban-scope.mobile .wx-board')).toBeVisible();
    for (let i = 0; i < 18; i++) {
      await page.getByRole('button', { name: 'Add card' }).click();
      await page.getByTitle('Close').click();
    }
    const list = page.locator(
      '.kanban-scope.mobile .wx-column:not(.mobile-list-transition-ghost) [data-kanban-column-cards]'
    );
    // The column must overflow by more than the coast the flick should earn.
    expect(
      await list.evaluate((el) => el.scrollHeight - el.clientHeight)
    ).toBeGreaterThan(300);
    const card = page.locator('.wx-card .kanban-card-body').nth(3);
    const cb = (await card.boundingBox())!;
    const x = cb.x + cb.width / 2;
    const y = cb.y + cb.height / 2;
    const result = await page.evaluate(
      async ({ x, y }) => {
        const list = document.querySelector<HTMLElement>(
          '.kanban-scope.mobile .wx-column:not(.mobile-list-transition-ghost) [data-kanban-column-cards]'
        )!;
        const target = document.elementFromPoint(x, y)!;
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        const fire = (type: string, cy: number, el: EventTarget) =>
          el.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              button: 0,
              pointerId: 31,
              pointerType: 'touch',
              clientX: x,
              clientY: cy
            })
          );
        fire('pointerdown', y, target);
        let cy = y;
        for (let i = 0; i < 6; i++) {
          await frame();
          cy -= 30;
          fire('pointermove', cy, window);
        }
        // Finger slows before lifting.
        await frame();
        cy -= 6;
        fire('pointermove', cy, window);
        fire('pointerup', cy, window);
        const atRelease = list.scrollTop;
        await new Promise((r) => setTimeout(r, 700));
        return { atRelease, after: list.scrollTop };
      },
      { x, y }
    );
    expect(result.after - result.atRelease).toBeGreaterThan(100);
  });
});
