import { expect, type Page } from '@playwright/test';

/** The details panel starts closed; open it for the active note. */
export async function openDetailsPanel(page: Page): Promise<void> {
  const toggle = page.getByRole('button', {
    name: 'Show right sidebar',
    exact: true
  });
  await expect(toggle).toBeEnabled();
  await toggle.click();
}
