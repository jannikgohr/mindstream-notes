import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Flow 1.1 (docs/e2e-flows.md): create → edit → reopen a markdown note.
 *
 * Browser-fallback (T2): the Milkdown editor serialises to markdown and the
 * in-memory mock store persists the body, so switching away from a note and
 * back proves the editor ⇄ store round-trip — and that markdown formatting
 * survives the serialise/parse cycle — without Tauri or SQLite. The same
 * journey against the real `save_note` IPC + SQLite is the T3 case.
 */

async function boot(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Welcome' })).toBeVisible();
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

async function createRootNote(page: Page, title: string) {
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  const draft = page.getByRole('textbox', { name: 'New note' });
  await expect(draft).toBeFocused();
  await draft.fill(title);
  await draft.press('Enter');
  await expect(treeItem(page, title)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('create → edit → reopen preserves rich markdown content', async ({
  page
}) => {
  const stamp = Date.now();
  const title = `Roundtrip ${stamp}`;
  const heading = `Project Alpha ${stamp}`;
  const body = `The quick brown fox jumps over the lazy dog ${stamp}.`;

  await createRootNote(page, title);
  await treeItem(page, title).click();

  // Type a heading (the '# ' markdown input rule) and a body paragraph.
  const ed = editor(page);
  await expect(ed).toBeVisible();
  await ed.click();
  await page.keyboard.type(`# ${heading}`);
  await page.keyboard.press('Enter');
  await page.keyboard.type(body);

  // The input rule produced a real heading element, and the body is there.
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  await expect(ed.getByText(body)).toBeVisible();

  // Switch to a different note — our content leaves the editor.
  await treeItem(page, 'Welcome').click();
  await expect(page.getByRole('heading', { name: heading })).toHaveCount(0);

  // Switch back — the heading and body survived serialise → persist → reload.
  await treeItem(page, title).click();
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  await expect(editor(page).getByText(body)).toBeVisible();
});
