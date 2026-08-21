import { expect, type Locator, type Page } from '@playwright/test';

export function fileTreeCreateAction(page: Page, name: string): Locator {
  return page
    .getByRole('button', { name, exact: true })
    .or(page.getByRole('menuitem', { name, exact: true }));
}

export async function openFileTreeCreateMore(page: Page): Promise<void> {
  const more = page
    .getByRole('complementary')
    .first()
    .getByRole('button', { name: 'More actions', exact: true });
  if ((await more.getAttribute('aria-expanded')) !== 'true') {
    await more.click();
  }
}

export async function revealFileTreeCreateAction(
  page: Page,
  name: string
): Promise<Locator> {
  const action = fileTreeCreateAction(page, name);
  if (!(await action.isVisible())) {
    await openFileTreeCreateMore(page);
  }
  await expect(action).toBeVisible();
  return action;
}

export async function clickFileTreeCreateAction(
  page: Page,
  name: string
): Promise<void> {
  await (await revealFileTreeCreateAction(page, name)).click();
}
