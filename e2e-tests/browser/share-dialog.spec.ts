import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Collection-share dialog in browser-fallback mode (T2). The mock API can't
 * actually send an invite — `inviteCollection` throws "only available in the
 * Tauri desktop app" — which makes fallback the perfect place to exercise the
 * BEST-EFFORT batch path: every recipient fails identically, so we can assert
 * the per-recipient failure reporting, the comma-splitting + de-duplication,
 * and the "keep the failed names for a retry" behaviour without a backend.
 *
 * The success path (a toast naming the invited users) needs a real server and
 * is covered at the unit level (toast store + recipient parsing).
 */

function fileTree(page: Page): Locator {
  return page.getByRole('group', { name: 'File tree' });
}

function shareDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: /^Share / });
}

async function openShareDialog(page: Page, folder: string) {
  await fileTree(page)
    .getByRole('button', { name: folder, exact: true })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Share folder/ }).click();
  await expect(shareDialog(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Welcome' })).toBeVisible();
});

test('shows the multi-user hint and placeholder', async ({ page }) => {
  await openShareDialog(page, 'Work');
  const input = shareDialog(page).getByRole('textbox');
  await expect(input).toHaveAttribute('placeholder', 'username, username');
  await expect(
    shareDialog(page).getByText('Separate multiple users with commas.')
  ).toBeVisible();
});

test('batch invite reports each recipient and keeps the failed names', async ({
  page
}) => {
  await openShareDialog(page, 'Work');
  const input = shareDialog(page).getByRole('textbox');

  // Duplicate "alice" must collapse to one entry (case-insensitive dedup).
  await input.fill('alice, bob, Alice');
  await shareDialog(page)
    .getByRole('button', { name: 'Invite', exact: true })
    .click();

  // Best-effort: a failure heading plus exactly one line per unique recipient.
  await expect(shareDialog(page).getByText("Couldn't invite:")).toBeVisible();
  const items = shareDialog(page).locator('li');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('alice');
  await expect(items.nth(1)).toContainText('bob');

  // The field is rewritten to the failed names so the user can fix + resend
  // without retyping the whole list.
  await expect(input).toHaveValue('alice, bob');
});

test('the Invite button is disabled until a name is entered', async ({
  page
}) => {
  await openShareDialog(page, 'Work');
  const invite = shareDialog(page).getByRole('button', {
    name: 'Invite',
    exact: true
  });
  await expect(invite).toBeDisabled();

  const input = shareDialog(page).getByRole('textbox');
  // Whitespace / lone commas parse to zero recipients — still disabled.
  await input.fill('  ,  ');
  await expect(invite).toBeDisabled();

  await input.fill('carol');
  await expect(invite).toBeEnabled();
});
