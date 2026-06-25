import { expect, test } from '@playwright/test';

/**
 * Smoke + navigation coverage for the desktop shell running in
 * browser-fallback mode. The mock store seeds Work / Personal folders and
 * Welcome / Sprint planning / Ideas notes, so these assertions are stable
 * across runs.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Wait for the SPA to hydrate the seeded tree.
  await expect(page.getByRole('button', { name: 'Welcome' })).toBeVisible();
});

test('renders the app shell with seeded content', async ({ page }) => {
  await expect(page).toHaveTitle(/Mindstream Notes/);

  // The four desktop note sources live in the left nav.
  for (const source of ['Home', 'Favourites', 'Shared', 'Trash']) {
    await expect(
      page.getByRole('button', { name: source, exact: true })
    ).toBeVisible();
  }

  // Seeded folders and the welcome note.
  await expect(
    page.getByRole('button', { name: 'Personal', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Work', exact: true })
  ).toBeVisible();

  // The fallback banner confirms we're on the mock store, not Tauri.
  await expect(page.getByText('browser fallback mode')).toBeVisible();
});

test('exposes the note-creation toolbar actions', async ({ page }) => {
  for (const action of [
    'New note',
    'New folder',
    'New drawing canvas',
    'New handwritten note',
    'Import PDF'
  ]) {
    await expect(
      page.getByRole('button', { name: action, exact: true })
    ).toBeVisible();
  }
});

test('toggles the colour theme from the header', async ({ page }) => {
  // The theme button's accessible name encodes the current mode and the
  // next one it will switch to, so a click should change that label.
  const themeButton = page.getByRole('button', { name: /^Theme:/ });
  const before = await themeButton.getAttribute('aria-label');
  await themeButton.click();
  await expect(themeButton).not.toHaveAttribute('aria-label', before ?? '');
});

test('collapses the left sidebar', async ({ page }) => {
  const personal = page.getByRole('button', { name: 'Personal', exact: true });
  await expect(personal).toBeVisible();
  await page.getByRole('button', { name: 'Toggle left sidebar' }).click();
  await expect(personal).toBeHidden();
});
