import { expect, test, type Locator, type Page } from '@playwright/test';
import { clickFileTreeCreateAction } from './file-tree-toolbar';

/**
 * The markdown editor's three floating menus: Crepe's selection toolbar,
 * Crepe's `/` slash menu, and our own formatting toolbar above the pane.
 *
 * None of them is reachable from unit tests — they are Vue components
 * Crepe mounts imperatively next to ProseMirror, driven by real pointer
 * gestures — and they are easy to break from a distance: any handler the
 * app installs on the editor region sees their events first. A regression
 * here (see `isEditorEndClick`) turned every formatting click into a no-op
 * that also threw the caret to the end of the note, which is exactly the
 * kind of thing these tests are meant to catch on the next run rather than
 * in the next bug report.
 */

async function boot(page: Page) {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Welcome', exact: true })
  ).toBeVisible();
}

function fileTree(page: Page): Locator {
  return page.getByRole('group', { name: 'File tree' });
}

function treeItem(page: Page, name: string): Locator {
  return fileTree(page).getByRole('button', { name, exact: true });
}

/** The live Milkdown (ProseMirror) contenteditable surface. */
function editor(page: Page): Locator {
  return page.locator('.ProseMirror').first();
}

/** Crepe's floating selection toolbar (hidden via `data-show='false'`). */
function selectionToolbar(page: Page): Locator {
  return page.locator('.milkdown-toolbar');
}

/**
 * Its buttons carry an icon and nothing else — no label, no title — so
 * position is the only handle. Crepe's default order is bold, italic,
 * strikethrough, then the function group.
 */
const SELECTION_TOOLBAR_ITEMS = { bold: 0, italic: 1, strikethrough: 2 };

/**
 * Crepe's slash menu. Each open note panel has one — they live in
 * body-level portals now (see $lib/editor/floating-portal.ts) instead of
 * inside the pane — so match the one that is actually open.
 */
function slashMenu(page: Page): Locator {
  return page.locator('.milkdown-slash-menu[data-show="true"]');
}

/** Our own toolbar above the editor pane, not one of Crepe's. */
function formattingToolbar(page: Page): Locator {
  return page.getByRole('toolbar', { name: 'Formatting' });
}

/**
 * Wait until the caret sits inside `selector`.
 *
 * Crepe mounts a slash-menu block (list item, heading) as its own component
 * and restores the selection into it a tick later. Typing before that lands
 * the first characters, then the caret jumps to the start of the new block
 * and the rest is typed in front of them — the text comes out scrambled.
 */
async function caretInside(page: Page, selector: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((sel) => {
        const node = window.getSelection()?.anchorNode ?? null;
        const el =
          node instanceof Element ? node : (node?.parentElement ?? null);
        return el?.closest(sel) !== null && el?.closest(sel) !== undefined;
      }, selector)
    )
    .toBe(true);
}

/** What the browser currently has selected, as plain text. */
function selectedText(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

async function createNote(page: Page, title: string) {
  await clickFileTreeCreateAction(page, 'New note');
  const draft = page.getByRole('textbox', { name: 'New note' });
  await expect(draft).toBeFocused();
  await draft.fill(title);
  await draft.press('Enter');
  await expect(treeItem(page, title)).toBeVisible();
  await treeItem(page, title).click();
  await expect(editor(page)).toBeVisible();
}

/**
 * The rect of the text inside a block, measured with a DOM Range — a
 * Range over the contents measures the glyphs, where the element's own
 * box spans the full text column. Ranges also see through the spans
 * spellcheck decorations wrap around individual words.
 */
async function textRect(line: Locator) {
  const rect = await line.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const box = range.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
  expect(rect.width, 'the line measured as empty').toBeGreaterThan(0);
  return rect;
}

/**
 * Type one paragraph and leave it fully selected — by dragging across it
 * with the mouse, the way a user does. A keyboard selection
 * (`Home`, `Shift+End`) selects the same text but does NOT bring up
 * Crepe's toolbar, so it would test something no user experiences.
 */
async function typeAndSelectLine(page: Page, text: string) {
  const ed = await focusEditor(page);
  await page.keyboard.type(text);
  const line = ed.getByText(text);
  await expect(line).toBeVisible();
  // Drag across the TEXT's own rect, not the paragraph's — the paragraph
  // box spans the whole column, so its edges are empty space below/beside
  // the glyphs, where the click-past-the-end gesture claims the press and
  // the drag produces no selection at all. hover() first, so the rect is
  // measured after the line has stopped moving.
  await line.hover();
  const rect = await textRect(line);
  const y = rect.y + rect.height / 2;
  await page.mouse.move(rect.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width - 1, y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => selectedText(page)).toBe(text);
}

/**
 * Click into the editor and wait until ProseMirror actually owns the
 * caret — the first keystroke after a bare click can otherwise land
 * before focus settles, and a `/` that misses the editor never opens
 * the slash menu.
 */
async function focusEditor(page: Page): Promise<Locator> {
  const ed = editor(page);
  await ed.click();
  await expect(ed).toHaveClass(/ProseMirror-focused/);
  return ed;
}

/**
 * Type a line, start a fresh block below it, and summon the slash menu
 * there. Going through a line the test typed itself proves the document
 * is live before the `/` — typing into a note the moment it opens can
 * race the collab binding, and a `/` that arrives mid-swap opens nothing.
 */
async function openSlashMenu(page: Page): Promise<Locator> {
  const ed = await focusEditor(page);
  const intro = `Intro ${Date.now()}`;
  await page.keyboard.type(intro);
  await expect(ed.getByText(intro)).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  const menu = slashMenu(page);
  await expect(menu).toBeVisible();
  return menu;
}

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test.describe('selection toolbar', () => {
  test('appears on a selection and applies bold to it', async ({ page }) => {
    const text = `Selection toolbar ${Date.now()}`;
    await createNote(page, `Toolbar ${Date.now()}`);
    await typeAndSelectLine(page, text);

    const toolbar = selectionToolbar(page);
    await expect(toolbar).toBeVisible();
    await toolbar
      .locator('.toolbar-item')
      .nth(SELECTION_TOOLBAR_ITEMS.bold)
      .click();

    // The command ran...
    await expect(editor(page).locator('strong')).toHaveText(text);
    // ...and the selection stayed on the words it was applied to. A
    // handler stealing the button's pointerdown used to collapse the
    // caret to the end of the document instead.
    await expect.poll(() => selectedText(page)).toBe(text);
  });

  test('applies italic, and toggling a mark off leaves the text', async ({
    page
  }) => {
    const text = `Italic run ${Date.now()}`;
    await createNote(page, `Italic ${Date.now()}`);
    await typeAndSelectLine(page, text);

    const italic = selectionToolbar(page)
      .locator('.toolbar-item')
      .nth(SELECTION_TOOLBAR_ITEMS.italic);
    await italic.click();
    await expect(editor(page).locator('em')).toHaveText(text);

    // Still selected, so the same button toggles the mark back off.
    await italic.click();
    await expect(editor(page).locator('em')).toHaveCount(0);
    await expect(editor(page).getByText(text)).toBeVisible();
  });

  test('hides when the user clicks outside the editor', async ({ page }) => {
    const text = `Click away ${Date.now()}`;
    await createNote(page, `Away ${Date.now()}`);
    await typeAndSelectLine(page, text);
    await expect(selectionToolbar(page)).toBeVisible();

    // Crepe only re-evaluates the toolbar on editor transactions, so a
    // click outside leaves it floating over the text — and, sitting above
    // the content, eating the next click. `installSelectionToolbarAutoHide`
    // is what takes it down; this is that helper's only live coverage.
    const tree = (await fileTree(page).boundingBox())!;
    await page.mouse.click(tree.x + tree.width / 2, tree.y + tree.height - 8);
    await expect(selectionToolbar(page)).toBeHidden();
  });
});

test.describe('slash menu', () => {
  test('turns the current line into a heading', async ({ page }) => {
    const heading = `Slashed heading ${Date.now()}`;
    await createNote(page, `Slash ${Date.now()}`);

    const menu = await openSlashMenu(page);
    await menu.getByText('Heading 1', { exact: true }).click();
    await expect(editor(page).locator('h1')).toBeVisible();
    await caretInside(page, 'h1');
    await page.keyboard.type(heading);

    // The block became a heading and the `/` trigger text is gone.
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await expect(editor(page)).not.toContainText('/');
  });

  test('offers the list group and applies a bullet list', async ({ page }) => {
    const item = `Slashed bullet ${Date.now()}`;
    await createNote(page, `Slash list ${Date.now()}`);

    const menu = await openSlashMenu(page);
    await menu.getByText('Bullet List', { exact: true }).click();
    const listItem = editor(page).locator('ul li');
    await expect(listItem).toBeVisible();
    await caretInside(page, 'li');
    await page.keyboard.type(item);

    await expect(listItem).toContainText(item);
  });

  test('does not make the note scroll past its content', async ({ page }) => {
    await createNote(page, `Slash scroll ${Date.now()}`);
    // Measure from the live editor outwards so the pane is unambiguous.
    const scrollHeight = () =>
      editor(page).evaluate((pm) => {
        const scroller = pm.closest('.milkdown')?.parentElement
          ?.parentElement as HTMLElement;
        return { scroll: scroller.scrollHeight, client: scroller.clientHeight };
      });

    const before = await scrollHeight();
    const menu = await openSlashMenu(page);
    await expect(menu).toBeVisible();
    const open = await scrollHeight();

    // The menu is ~480px tall. Left inside the scrolling pane — where
    // SlashProvider puts it by default — an absolutely positioned box that
    // size adds its own height to the scrollable area, and the note scrolls
    // hundreds of pixels past its last line. It lives in a body-level
    // portal instead, so the only growth here is the empty block the test
    // typed to summon it.
    expect(open.scroll - before.scroll).toBeLessThan(80);
    // The menu is really down there and really visible — otherwise the
    // assertion above passes for the wrong reason.
    const box = (await menu.boundingBox())!;
    expect(box.height).toBeGreaterThan(100);
  });

  test('closes on Escape without touching the line', async ({ page }) => {
    await createNote(page, `Slash escape ${Date.now()}`);

    await openSlashMenu(page);

    await page.keyboard.press('Escape');
    await expect(slashMenu(page)).toHaveCount(0);
    await expect(editor(page)).toContainText('/');
  });
});

test.describe('formatting toolbar', () => {
  test('applies bold to the selection', async ({ page }) => {
    const text = `Toolbar bold ${Date.now()}`;
    await createNote(page, `Bar bold ${Date.now()}`);
    await typeAndSelectLine(page, text);

    await formattingToolbar(page).getByRole('button', { name: 'Bold' }).click();
    await expect(editor(page).locator('strong')).toHaveText(text);
  });

  test('applies a heading from the Text group menu', async ({ page }) => {
    const text = `Toolbar heading ${Date.now()}`;
    await createNote(page, `Bar heading ${Date.now()}`);
    await focusEditor(page);
    await page.keyboard.type(text);

    await formattingToolbar(page).getByRole('button', { name: 'Text' }).click();
    await page
      .getByRole('menu')
      .getByRole('menuitem', { name: 'Heading 2' })
      .click();

    await expect(
      page.getByRole('heading', { name: text, level: 2 })
    ).toBeVisible();
  });
});

test('clicking past the end of the text puts the caret at the end', async ({
  page
}) => {
  // The gesture whose over-eager hit test broke the menus above: the
  // pane is taller than the document, so a click in the empty space
  // below the last block has to be turned into a caret by hand.
  const first = `First line ${Date.now()}`;
  await createNote(page, `End click ${Date.now()}`);
  const ed = await focusEditor(page);
  await page.keyboard.type(first);

  const box = await ed.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height - 8);
  await page.keyboard.type(' appended');

  await expect(ed).toContainText(`${first} appended`);
});
