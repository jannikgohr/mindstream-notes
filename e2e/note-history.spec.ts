import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Browser-fallback (T2) coverage for the note-history sidebar section.
 *
 * The in-memory mock store implements the capture / list / restore APIs, and
 * the Milkdown editor registers its live document with the history bridge, so
 * the whole sidebar journey runs without Tauri, SQLite, or a backend: a
 * baseline capture on open, an edited version after typing, and the restore +
 * one-click Undo affordance.
 *
 * The *durability* of these versions — surviving a real app restart, through
 * the Rust history table and SQLite — is deliberately a T3 (tauri-driver)
 * concern; see docs/e2e-strategy.md §4. This file proves the UI wiring only.
 */

async function boot(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Welcome' })).toBeVisible();
}

function fileTree(page: Page): Locator {
  return page.getByRole('group', { name: 'File tree' });
}

/** Open the seeded markdown note "Ideas" (under Personal) in the editor. */
async function openIdeas(page: Page) {
  await page.getByRole('button', { name: 'Personal', exact: true }).click();
  await fileTree(page)
    .getByRole('button', { name: 'Ideas', exact: true })
    .click();
  // The editor mounted and the metadata panel reflects the markdown note.
  await expect(page.getByText('Markdown note')).toBeVisible();
}

/** The live Milkdown (ProseMirror) contenteditable surface. */
function editor(page: Page): Locator {
  return page.locator('.ProseMirror').first();
}

async function typeInEditor(page: Page, text: string) {
  const ed = editor(page);
  await ed.click();
  await page.keyboard.type(text);
}

/** History section "Refresh history" button — snapshots the live doc, re-lists. */
async function refreshHistory(page: Page) {
  await page.getByRole('button', { name: 'Refresh history' }).click();
}

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('captures a baseline "created" version when a note opens', async ({
  page
}) => {
  await openIdeas(page);

  // Opening a markdown note snapshots a baseline; the first version for a note
  // is promoted to a "Note created" entry.
  await expect(page.getByText('Note created')).toBeVisible();
});

test('records an edited version after typing and refreshing', async ({
  page
}) => {
  await openIdeas(page);
  await expect(page.getByText('Note created')).toBeVisible();

  await typeInEditor(page, ' extra words that make a brand new version');
  await refreshHistory(page);

  // The changed content produces a fresh, non-deduped "Edited" entry on top of
  // the baseline.
  await expect(page.getByText('Edited', { exact: true }).first()).toBeVisible();
});

test('restores an earlier version and offers a one-click undo', async ({
  page
}) => {
  await openIdeas(page);
  await expect(page.getByText('Note created')).toBeVisible();

  // Make the live content differ from the baseline so a restore is meaningful.
  await typeInEditor(page, ' a clearly different body for the restore test');
  await refreshHistory(page);
  await expect(page.getByText('Edited', { exact: true }).first()).toBeVisible();

  // Open the baseline version; desktop markdown shows it in the compare modal.
  await page.getByRole('button', { name: /Note created/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Restore this version' }).click();

  // The restore lands and the (sidebar-scoped) Undo affordance appears.
  const banner = page.getByRole('status').filter({
    hasText: 'Restored to an earlier version.'
  });
  await expect(banner).toBeVisible();
  const undo = banner.getByRole('button', { name: 'Undo' });
  await expect(undo).toBeEnabled();

  await undo.click();
  await expect(page.getByText('Restored to an earlier version.')).toHaveCount(
    0
  );
});
