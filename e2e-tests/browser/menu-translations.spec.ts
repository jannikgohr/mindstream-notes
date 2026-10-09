import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The file menus and mobile sheets in a second language.
 *
 * Every other spec runs in English, where a label that bypasses the
 * translation bundle looks exactly like one that goes through it. German is
 * the only way to see the difference. It also pins the menu icons: they used
 * to be guessed from the label's wording, so a translated or reworded label
 * could silently lose its icon.
 */

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

test.beforeEach(async ({ page }) => {
  // The app reads its language from localStorage before first render.
  await page.addInitScript(() =>
    localStorage.setItem('notes-app:language', 'de')
  );
});

async function expectIconOnEveryItem(items: Locator) {
  for (const item of await items.all()) {
    await expect(item.locator('svg')).toHaveCount(1);
  }
}

test.describe('desktop file tree', () => {
  function treeItem(page: Page, name: string): Locator {
    return page
      .getByRole('group', { name: 'Dateibaum' })
      .getByRole('button', { name, exact: true });
  }

  test('translates the note menu and keeps every icon', async ({ page }) => {
    await page.goto('/');
    await treeItem(page, 'Welcome').click({ button: 'right' });

    // Whitespace-tolerant: the row's text includes the gap around its icon,
    // and rows that advertise a shortcut carry its key cap after the label.
    const items = page.getByRole('menu').getByRole('menuitem');
    await expect(items).toHaveText([
      /^\s*Öffnen\s*$/,
      /^\s*Rechts öffnen\s*$/,
      /^\s*Unten öffnen\s*$/,
      /^\s*In neuem Fenster öffnen\s*$/,
      /^\s*Umbenennen…/,
      /^\s*In den Stamm verschieben\s*$/,
      /^\s*Löschen/
    ]);
    await expectIconOnEveryItem(items);
  });

  test('translates the folder menu and keeps every icon', async ({ page }) => {
    await page.goto('/');
    await treeItem(page, 'Personal').click({ button: 'right' });

    const items = page.getByRole('menu').getByRole('menuitem');
    await expect(items.first()).toHaveText('Neue Notiz');
    await expect(items.filter({ hasText: 'Ordner umbenennen…' })).toHaveCount(
      1
    );
    await expect(
      items.filter({ hasText: 'In den Stamm verschieben' })
    ).toHaveCount(1);
    await expect(items.last()).toHaveText(/^\s*Löschen/);
    await expectIconOnEveryItem(items);
  });
});

test.describe('mobile note list', () => {
  // The mobile shell is chosen from navigator.userAgent (see lib/platform.ts).
  test.use({ userAgent: ANDROID_UA, viewport: { width: 412, height: 915 } });

  async function openRowMenu(page: Page): Promise<Locator> {
    const row = page
      .locator('.mobile-note-list li')
      .filter({ has: page.getByRole('button', { name: /Welcome/ }) });
    await row.getByRole('button', { name: 'Weitere Aktionen' }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    return menu;
  }

  test('translates the row menu and the rename sheet', async ({ page }) => {
    await page.goto('/');
    const menu = await openRowMenu(page);
    const items = menu.getByRole('menuitem');
    await expect(items).toHaveText([
      'Auswählen',
      'Umbenennen',
      'Verschieben nach…',
      'Löschen'
    ]);
    await expectIconOnEveryItem(items);

    await menu.getByRole('menuitem', { name: 'Umbenennen' }).click();
    const sheet = page.getByRole('dialog', { name: 'Notiz umbenennen' });
    await expect(sheet.getByRole('textbox')).toHaveAttribute(
      'placeholder',
      'Notiztitel'
    );
    await expect(sheet.getByText('Abbrechen', { exact: true })).toBeVisible();
    await expect(
      sheet.getByRole('button', { name: 'Speichern', exact: true })
    ).toBeVisible();
  });

  test('translates batch selection and the move sheet', async ({ page }) => {
    await page.goto('/');
    const menu = await openRowMenu(page);
    await menu.getByRole('menuitem', { name: 'Auswählen' }).click();

    // The count is interpolated into the translated sentence.
    await expect(page.getByText('1 ausgewählt', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Alle auswählen', exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole('checkbox', { name: 'Auswahl von Welcome aufheben' })
    ).toBeChecked();

    await page
      .getByRole('button', { name: 'Verschieben nach…', exact: true })
      .click();
    const sheet = page.getByRole('dialog', { name: 'In Ordner verschieben' });
    await expect(sheet.getByText('Verschieben nach…')).toBeVisible();
    // A folder name is interpolated into the destination's tooltip.
    await expect(
      sheet.getByRole('button', { name: 'Personal', exact: true })
    ).toHaveAttribute('title', 'Nach „Personal“ verschieben');
    await expect(
      sheet.getByRole('button', { name: 'Stamm', exact: true })
    ).toHaveAttribute('title', 'In den Stamm verschieben');
  });
});
