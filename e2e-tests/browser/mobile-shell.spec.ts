import { expect, test } from '@playwright/test';

/**
 * The mobile shell's chrome, which follows the desktop's: the vault tile
 * opens the vault sheet, the create bar shows the default kind and pinned
 * kinds and its sortable menu changes both, and the note details sheet reads
 * once.
 *
 * The mobile shell is chosen from navigator.userAgent (see lib/platform.ts).
 */

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

test.use({
  userAgent: ANDROID_UA,
  viewport: { width: 412, height: 915 },
  hasTouch: true
});

test('the vault tile opens the vault sheet', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Switch vault' }).click();
  const sheet = page.getByRole('dialog', { name: 'Vaults' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Default', { exact: true })).toBeVisible();
});

test('the create menu pins quick buttons and sorts the default to the top', async ({
  page
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'New note', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'New folder', exact: true })
  ).toBeVisible();

  await page
    .getByRole('button', { name: 'Show everything you can create' })
    .click();
  const menu = page.getByRole('dialog', { name: 'Create' });
  // Pins can be many: unpinning one takes its quick button away.
  const pinFolder = menu.getByRole('button', {
    name: 'Show New folder beside the button'
  });
  await expect(pinFolder).toHaveAttribute('aria-pressed', 'true');
  await pinFolder.click();
  await expect(pinFolder).toHaveAttribute('aria-pressed', 'false');
  // Dragging a type to the top makes it the default, and the list says so
  // before the drop: the marker reads "Default" and the old default loses it.
  const handle = menu.getByRole('button', {
    name: 'Move New handwritten note'
  });
  const top = menu.locator('[data-create-row]').first();
  const from = (await handle.boundingBox())!;
  const to = (await top.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 12 });
  await expect(menu.locator('.border-dashed')).toHaveText('Default');
  await expect(menu.locator('[data-create-row="note"]')).not.toContainText(
    'Default'
  );
  await page.mouse.up();
  await expect(menu.locator('[data-create-row]').first()).toContainText(
    'New handwritten note'
  );
  await page.getByRole('button', { name: 'Close action menu' }).first().click();

  const main = page.getByRole('button', {
    name: 'New handwritten note',
    exact: true
  });
  await expect(main).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'New folder', exact: true })
  ).toHaveCount(0);

  // Both choices are the device's toolbar order, so they survive a reload.
  await page.reload();
  await expect(main).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'New folder', exact: true })
  ).toHaveCount(0);
});

test('note details open as one sheet with a single heading', async ({
  page
}) => {
  await page.goto('/');
  await page
    .locator('.mobile-note-list')
    .getByRole('button', { name: /Welcome/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Show note details' }).click();
  const sheet = page.getByRole('dialog', { name: 'Note details' });
  await expect(sheet).toBeVisible();
  await expect(
    sheet.getByRole('heading', { name: 'Note details' })
  ).toHaveCount(1);
});

test('plugin create actions keep their IDs in a separate mobile layout', async ({
  page
}) => {
  const desktopKey = 'notes-app:file-tree-create-toolbar:v1';
  const mobileKey = 'notes-app:mobile-create-toolbar:v1';
  const pluginId = 'plugin:com.mindstream.templates.core:new-from-template';
  const desktop = {
    toolbar: ['note', 'folder'],
    more: ['drawing', 'ink', 'kanban', 'pdf', pluginId]
  };
  await page.addInitScript(
    ({ desktopKey, desktop }) => {
      if (!localStorage.getItem(desktopKey))
        localStorage.setItem(desktopKey, JSON.stringify(desktop));
    },
    { desktopKey, desktop }
  );
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Show everything you can create' })
    .click();
  const menu = page.getByRole('dialog', { name: 'Create' });
  await expect(
    menu.getByRole('button', { name: 'New from template', exact: true })
  ).toBeVisible();
  await menu
    .getByRole('button', { name: 'Show New from template beside the button' })
    .click();
  const handle = menu.getByRole('button', { name: 'Move New from template' });
  await handle.focus();
  await handle.press('ArrowUp');
  await handle.press('ArrowUp');
  await expect(menu.locator('[data-create-row]').first()).toHaveAttribute(
    'data-create-row',
    pluginId
  );
  await page.getByRole('button', { name: 'Close action menu' }).first().click();
  const stored = await page.evaluate(
    ({ desktopKey, mobileKey }) => ({
      desktop: JSON.parse(localStorage.getItem(desktopKey)!),
      mobile: JSON.parse(localStorage.getItem(mobileKey)!)
    }),
    { desktopKey, mobileKey }
  );
  expect(stored.desktop).toEqual(desktop);
  expect(stored.mobile.toolbar[0]).toBe(pluginId);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'New from template', exact: true })
  ).toBeVisible();
});
