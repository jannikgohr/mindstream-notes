import { expect, test } from '@playwright/test';
import { clickFileTreeCreateAction } from './file-tree-toolbar';

test('outline follows the open note and scrolls to its live headings', async ({
  page
}) => {
  await page.goto('/');
  const tree = page.getByRole('group', { name: 'File tree' });
  await expect(
    tree.getByRole('button', { name: 'Welcome', exact: true })
  ).toBeVisible();
  await clickFileTreeCreateAction(page, 'New note');
  const draft = page.getByRole('textbox', { name: 'New note' });
  await draft.fill('Outline document');
  await draft.press('Enter');
  await tree
    .getByRole('button', { name: 'Outline document', exact: true })
    .click();

  const editor = page.locator('.ProseMirror').last();
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type('# Overview');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText(
    'A paragraph to make the document scroll. '.repeat(100)
  );
  await page.keyboard.press('Enter');
  await page.keyboard.type('## Decisions');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('Keep the navigation and details consistent.');

  const outline = page.getByRole('navigation', {
    name: 'Outline',
    exact: true
  });
  await expect(
    outline.getByRole('button', { name: 'Go to Overview', exact: true })
  ).toBeVisible();
  await expect(
    outline.getByRole('button', { name: 'Go to Decisions', exact: true })
  ).toBeVisible();
  await outline
    .getByRole('button', { name: 'Go to Overview', exact: true })
    .click();
  const scroller = editor.locator(
    'xpath=ancestor::div[contains(@class,"themed-scrollbar")][1]'
  );
  const overviewScroll = await scroller.evaluate(
    (element) => element.scrollTop
  );
  await outline
    .getByRole('button', { name: 'Go to Decisions', exact: true })
    .click();
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(overviewScroll + 200);

  await tree.getByRole('button', { name: 'Welcome', exact: true }).click();
  await expect(
    outline.getByRole('button', { name: 'Go to Welcome', exact: true })
  ).toBeVisible();
  await expect(
    outline.getByRole('button', { name: 'Go to Decisions', exact: true })
  ).toHaveCount(0);

  // Collapsing the outline leaves the details and history available in the same pane.
  await page.locator('.note-details-panel summary').click();
  await expect(outline).toBeHidden();
  await expect(
    page
      .locator('.note-details-panel dt')
      .filter({ hasText: /^\s*Created\s*$/ })
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'History', exact: true })
  ).toBeVisible();
});
