import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Markdown round-trip fidelity through the REAL Milkdown parser/serializer.
 *
 * The Source pane renders `getMarkdown()` — the same serialization that lands in
 * the saved note body, history diffs and exports — so driving it is the cheapest
 * honest way to assert "what goes in comes back out". Each test here pins a bug
 * we actually shipped and fixed:
 *
 *   - `*` bullets / loose (blank-line-separated) bullet lists   → 925913c
 *   - empty paragraphs leaking a literal `<br />` into markdown → b8e269f
 *   - blank lines vanishing when the note is edited in Source   → fa69619
 *   - trailing blank lines being trimmed away                   → b6d9e61
 *
 * The blank-line mapping is `k empty paragraphs <-> (k + 1) blank lines`; the
 * parse half of that is unit tested in src/lib/editor/plugins/blank-lines.test.ts.
 */

function modeButton(page: Page): Locator {
  return page.getByRole('button', { name: /^Editor view mode:/ });
}

function sourcePane(page: Page): Locator {
  return page.locator('.cm-content');
}

function wysiwygPane(page: Page): Locator {
  return page.locator('.ProseMirror').first();
}

async function boot(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Welcome' })).toBeVisible();
  await expect(wysiwygPane(page)).toBeVisible();
  // The mode toggle only appears once the editor is interactive.
  await expect(modeButton(page)).toBeVisible();
}

/** Cycle the single view-mode button until it reports `target`. */
async function setMode(page: Page, target: 'WYSIWYG' | 'Source' | 'Split') {
  for (let i = 0; i < 4; i++) {
    const label = await modeButton(page).getAttribute('aria-label');
    if (label === `Editor view mode: ${target}`) return;
    await modeButton(page).click();
  }
  throw new Error(`could not reach view mode ${target}`);
}

/** The Source pane's exact text, reconstructed from CodeMirror's line divs
 *  (innerText would inflate blank lines — each renders as a <br>). */
async function sourceText(page: Page): Promise<string> {
  const lines = await page.locator('.cm-line').allTextContents();
  return lines.join('\n');
}

/** Replace the Source document. `insertText` rather than `type` so no keymap
 *  (list continuation, auto-pairs) can reinterpret what we send. */
async function setSourceText(page: Page, text: string) {
  await sourcePane(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
  // Let the debounced source → doc sync land in the Yjs document.
  await expect
    .poll(async () => (await sourceText(page)).length, { timeout: 5_000 })
    .toBeGreaterThan(0);
  await page.waitForTimeout(400);
}

/**
 * Force a full markdown → doc → markdown loop and return the canonical result:
 * leaving Source unmounts the pane, and coming back re-seeds it from
 * `getMarkdown()` of the live document.
 */
async function roundTrip(page: Page): Promise<string> {
  await setMode(page, 'WYSIWYG');
  await page.waitForTimeout(300);
  await setMode(page, 'Source');
  await expect(sourcePane(page)).toBeVisible();
  await page.waitForTimeout(300);
  return sourceText(page);
}

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('canonical markdown survives a round-trip byte-for-byte', async ({
  page
}) => {
  await setMode(page, 'Source');
  // Tight bullet list + `-` markers + ordered list: the exact shape that used
  // to come back as `* alpha` with a blank line between every item. Ends on a
  // paragraph so no structural trailing node is involved (see the list test
  // below).
  const doc = [
    '# Title',
    '',
    'Para text',
    '',
    '- alpha',
    '- beta',
    '',
    '1. one',
    '2. two',
    '',
    'Closing para'
  ].join('\n');
  await setSourceText(page, doc);

  const out = await roundTrip(page);
  // Trailing newline is the ordinary end-of-file, hence the trailing ''.
  expect(out).toBe(`${doc}\n`);
});

test('a document ending in a list keeps its content and stays stable', async ({
  page
}) => {
  await setMode(page, 'Source');
  const doc = ['# Title', '', '- alpha', '- beta'].join('\n');
  await setSourceText(page, doc);

  // ProseMirror keeps a structural trailing paragraph after a block-level node
  // like a list (so you can put a cursor below it), which serializes to one
  // extra blank line. The content itself must be untouched — bullets stay `-`
  // and the list stays tight...
  const first = await roundTrip(page);
  expect(first.startsWith(doc)).toBe(true);
  expect(first).not.toContain('<br');
  expect(first).not.toContain('* alpha');

  // ...and crucially the trailing blank must not grow on every pass.
  expect(await roundTrip(page)).toBe(first);
});

test('a round-trip is idempotent (a second pass changes nothing)', async ({
  page
}) => {
  await setMode(page, 'Source');
  await setSourceText(page, ['## Heading', '', '- a', '- b'].join('\n'));

  const first = await roundTrip(page);
  const second = await roundTrip(page);
  expect(second).toBe(first);
});

test('empty paragraphs never serialize to a literal <br />', async ({
  page
}) => {
  // Blank paragraphs made in WYSIWYG used to emit `<br />` into the markdown,
  // which reappeared every time it was deleted while a peer sat in WYSIWYG.
  await setMode(page, 'WYSIWYG');
  await wysiwygPane(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('End');

  await setMode(page, 'Source');
  await page.waitForTimeout(300);
  expect(await sourceText(page)).not.toContain('<br');
});

test('blank lines added in WYSIWYG survive being edited in Source', async ({
  page
}) => {
  await setMode(page, 'WYSIWYG');
  await wysiwygPane(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('End');

  // Enter x3 leaves two empty paragraphs → k + 1 = 3 blank lines.
  await setMode(page, 'Split');
  await page.waitForTimeout(300);
  const before = await sourceText(page);
  expect(before).toMatch(/\n\n\n\nEnd/);

  // Editing in Source used to collapse those blank lines away entirely.
  await sourcePane(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('!');
  await page.waitForTimeout(400);

  expect(await sourceText(page)).toMatch(/\n\n\n\nEnd/);
});

test('trailing blank lines are preserved and do not accumulate', async ({
  page
}) => {
  await setMode(page, 'Source');
  // 'Body text' + 3 extra blank lines at the end (4 trailing newlines).
  await setSourceText(page, 'Body text\n\n\n\n');

  const first = await roundTrip(page);
  expect(first).toBe('Body text\n\n\n\n');

  // Stable: the count must not grow (or shrink) on further passes.
  const second = await roundTrip(page);
  expect(second).toBe(first);
});

test('a document with no trailing blank lines stays that way', async ({
  page
}) => {
  await setMode(page, 'Source');
  await setSourceText(page, 'Plain doc no trailing');

  const first = await roundTrip(page);
  expect(first).toBe('Plain doc no trailing\n');
  expect(await roundTrip(page)).toBe(first);
});
