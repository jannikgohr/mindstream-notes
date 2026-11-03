import { expect, test, type Page } from '@playwright/test';

/**
 * Dragging a tab to a new place in the strip.
 *
 * Dockview opens a gap for the dragged tab by giving the tab after it an
 * inline `margin-left`. A pointer drop that commits a reorder must take that
 * margin away again, or the strip keeps an empty slot between the tabs.
 */

function treeItem(page: Page, name: string) {
  return page
    .getByRole('group', { name: 'File tree' })
    .getByRole('button', { name, exact: true });
}

const tabs = (page: Page) => page.locator('.dv-tabs-container > .dv-tab');

/** Each tab's text, left edge, width and inline margin, in strip order. */
function strip(page: Page) {
  return tabs(page).evaluateAll((elements) =>
    elements.map((tab) => {
      const box = tab.getBoundingClientRect();
      return {
        title: tab.textContent?.trim() ?? '',
        left: box.left,
        right: box.right,
        inlineMargin: (tab as HTMLElement).style.marginLeft
      };
    })
  );
}

async function openTwoTabs(page: Page) {
  await page.goto('/');
  await treeItem(page, 'Welcome').dblclick();
  await treeItem(page, 'Work').click();
  await treeItem(page, 'Sprint planning').dblclick();
  await expect(tabs(page)).toHaveCount(2);
}

/**
 * Press on tab `from`, move through `waypoints` (x positions) at a hand's
 * pace, pause, and release.
 */
async function dragTab(page: Page, from: number, waypoints: number[]) {
  const source = (await tabs(page).nth(from).boundingBox())!;
  const y = source.y + source.height / 2;
  let x = source.x + source.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (const next of waypoints) {
    for (let step = 1; step <= 10; step++) {
      await page.mouse.move(x + ((next - x) * step) / 10, y);
      await page.waitForTimeout(16);
    }
    x = next;
  }
  // A person pauses over the slot before letting go.
  await page.waitForTimeout(300);
  await page.mouse.up();
}

/** After the shift animation and Dockview's 300 ms cleanup fallback. */
async function settledStrip(page: Page) {
  await page.waitForTimeout(500);
  return strip(page);
}

test('moving the second tab before the first leaves no gap', async ({
  page
}) => {
  await openTwoTabs(page);
  const before = await strip(page);
  await dragTab(page, 1, [before[0].left + 20]);

  await expect
    .poll(async () => (await strip(page)).map((tab) => tab.title))
    .toEqual([before[1].title, before[0].title]);
  const after = await settledStrip(page);
  expect(after.map((tab) => tab.inlineMargin)).toEqual(['', '']);
  expect(after[1].left).toBeCloseTo(after[0].right, 0);
  expect(after[0].left).toBeCloseTo(before[0].left, 0);
});

test('dropping a tab back in its own place leaves no gap', async ({ page }) => {
  await openTwoTabs(page);
  const before = await strip(page);
  const home = (before[1].left + before[1].right) / 2;
  await dragTab(page, 1, [before[0].left + 20, home]);

  const after = await settledStrip(page);
  expect(after.map((tab) => tab.title)).toEqual(before.map((tab) => tab.title));
  expect(after.map((tab) => tab.inlineMargin)).toEqual(['', '']);
  expect(after[1].left).toBeCloseTo(after[0].right, 0);
});
