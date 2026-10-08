import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The mobile note list's row menu and the name sheet it opens.
 *
 * Both are layout-level behaviours unit tests can't see: the menu's icons
 * are picked per item at render time, and the sheet's position depends on
 * the visual viewport, which only a real browser has.
 *
 * The mobile shell is chosen from navigator.userAgent (see lib/platform.ts),
 * so the UA override below is what puts us on MobileLayout in the
 * browser-fallback SPA.
 */

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const VIEWPORT = { width: 412, height: 915 };
const KEYBOARD_HEIGHT = 320;

test.use({ userAgent: ANDROID_UA, viewport: VIEWPORT });

function bottomNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Primary' });
}

/** Open the "…" menu of the seeded Welcome note's row. */
async function openRowMenu(page: Page): Promise<Locator> {
  await page.goto('/');
  const row = page
    .locator('.mobile-note-list li')
    .filter({ has: page.getByRole('button', { name: /Welcome/ }) });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'More actions' }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * Play a soft keyboard the way edge-to-edge Android delivers one: the visual
 * viewport shrinks while the window (the layout viewport) keeps its height.
 * Desktop Chromium has no soft keyboard, so the height is overridden on the
 * real `visualViewport` object and its own resize event is dispatched — the
 * app's listeners run exactly as they would on a device. `0` puts the
 * genuine value back.
 */
async function setKeyboard(page: Page, height: number) {
  await page.evaluate((keyboard) => {
    const vv = window.visualViewport;
    if (!vv) throw new Error('no visualViewport');
    if (keyboard === 0) {
      delete (vv as { height?: number }).height;
    } else {
      Object.defineProperty(vv, 'height', {
        configurable: true,
        get: () => window.innerHeight - keyboard
      });
    }
    vv.dispatchEvent(new Event('resize'));
  }, height);
}

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  expect(rect, 'element has no box').not.toBeNull();
  return rect!;
}

test('every row action has an icon', async ({ page }) => {
  const menu = await openRowMenu(page);
  const items = menu.getByRole('menuitem');
  await expect(items).toHaveText(['Select', 'Rename', 'Move to…', 'Delete']);
  // "Select" used to be the one item without an icon: icons were guessed
  // from the label text and nothing matched it.
  for (const item of await items.all()) {
    await expect(item.locator('svg')).toHaveCount(1);
  }
});

test('the rename sheet rides on the keyboard and the list behind it stays put', async ({
  page
}) => {
  const menu = await openRowMenu(page);
  await menu.getByRole('menuitem', { name: 'Rename' }).click();

  const sheet = page.getByRole('dialog', { name: 'Rename note' });
  const field = sheet.getByRole('textbox');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('Welcome');

  const navBefore = await box(bottomNav(page));
  const sheetBefore = await box(sheet);
  // No keyboard yet: the sheet rests on the bottom edge of the window.
  expect(sheetBefore.y + sheetBefore.height).toBeCloseTo(VIEWPORT.height, 0);

  await setKeyboard(page, KEYBOARD_HEIGHT);

  // The sheet's bottom edge now sits on the keyboard's top edge, so the
  // field is in the visible area without the WebView panning the page.
  const visibleBottom = VIEWPORT.height - KEYBOARD_HEIGHT;
  await expect
    .poll(async () => {
      const rect = await box(sheet);
      return Math.round(rect.y + rect.height);
    })
    .toBe(visibleBottom);
  const fieldBox = await box(field);
  expect(fieldBox.y + fieldBox.height).toBeLessThan(visibleBottom);

  // The screen behind the scrim did not rearrange: the bottom nav is where
  // it was. Without the hold it jumps up by the keyboard's height.
  expect(await box(bottomNav(page))).toEqual(navBefore);

  // Closing the keyboard drops the sheet back to the window's bottom edge.
  await setKeyboard(page, 0);
  await expect
    .poll(async () => {
      const rect = await box(sheet);
      return Math.round(rect.y + rect.height);
    })
    .toBe(VIEWPORT.height);
  expect(await box(bottomNav(page))).toEqual(navBefore);
});

test('the shell follows the keyboard again once the sheet is closed', async ({
  page
}) => {
  const menu = await openRowMenu(page);
  await menu.getByRole('menuitem', { name: 'Rename' }).click();
  const sheet = page.getByRole('dialog', { name: 'Rename note' });
  await expect(sheet.getByRole('textbox')).toBeFocused();
  const navBefore = await box(bottomNav(page));

  // By text: the sheet's X carries the same accessible name.
  await sheet.getByText('Cancel', { exact: true }).click();
  await expect(sheet).toHaveCount(0);

  // The editor depends on the shell shrinking to the visible area (it keeps
  // the caret above the keyboard), so the sheet's hold must not outlive it.
  await setKeyboard(page, KEYBOARD_HEIGHT);
  await expect
    .poll(async () => Math.round((await box(bottomNav(page))).y))
    .toBe(Math.round(navBefore.y - KEYBOARD_HEIGHT));
});
