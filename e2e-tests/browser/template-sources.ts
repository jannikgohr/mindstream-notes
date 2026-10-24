import { expect, type Page } from '@playwright/test';

/** Configure the real picker in either shell. Browser fallback settings reset on reload. */
export async function setTemplateFolder(
  page: Page,
  folder: string | null = 'Personal'
) {
  await page
    .getByRole('button', { name: /^(Open settings|Settings)$/ })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', { name: 'Plugins', exact: true })
    .first()
    .click();
  await dialog.getByRole('button', { name: 'Plugin settings' }).click();
  const picker = dialog.getByRole('button', {
    name: 'Template folder',
    exact: true
  });
  await picker.click();
  if (folder)
    await dialog.getByRole('option', { name: folder, exact: true }).click();
  else await dialog.getByRole('option').first().click();
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
}
