import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

async function ready(page: Page) {
  await page.goto('/sqlite-proof/');
  const status = page.getByRole('status');
  await expect(status).toBeVisible();
  await expect(status).not.toHaveText('Opening database', { timeout: 30_000 });
  if (
    test.info().project.name === 'webkit' &&
    (await status.getAttribute('data-error-code')) === 'unsupported'
  ) {
    const opfsAvailable = await page.evaluate(
      () => typeof navigator.storage?.getDirectory === 'function'
    );
    test.skip(
      !opfsAvailable,
      'This Playwright WebKit build has no OPFS API. Run this project on an OPFS-capable WebKit build.'
    );
  }
  await expect(status).toHaveText('Ready');
}

test('real migrations, FTS5, rollback, foreign keys, and CRDT run in the worker', async ({
  page
}) => {
  await ready(page);
  const report = JSON.parse(await page.getByTestId('proof-report').innerText());
  expect(report).toMatchObject({
    schemaVersion: 34,
    journalMode: 'delete',
    upgrades: 11,
    fts5: true,
    transactions: true,
    foreignKeys: true,
    crdt: true
  });
  expect(report.sqliteVersion).toMatch(/^3\./);
});

test('a committed transaction survives reload, close, and reopen', async ({
  page
}) => {
  await ready(page);
  await page.getByLabel('Persistence marker').fill('persisted after reload 🔒');
  await page.getByRole('button', { name: 'Save marker' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Ready');
  await expect(page.getByTestId('persisted-marker')).toHaveText(
    'persisted after reload 🔒'
  );
  await page.getByRole('button', { name: 'Close database' }).click();
  await expect(page.getByRole('status')).toHaveText('Closed');
  await page.getByRole('button', { name: 'Retry opening' }).click();
  await expect(page.getByRole('status')).toHaveText('Ready');
  await expect(page.getByTestId('persisted-marker')).toHaveText(
    'persisted after reload 🔒'
  );
});

test('a second tab is refused, then opens the same data after the owner closes', async ({
  page,
  context
}) => {
  await ready(page);
  await page.getByLabel('Persistence marker').fill('one writer');
  await page.getByRole('button', { name: 'Save marker' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  const second = await context.newPage();
  await second.goto('/sqlite-proof/');
  await expect(second.getByRole('status')).toHaveAttribute(
    'data-error-code',
    'databaseBusy'
  );
  await page.getByRole('button', { name: 'Close database' }).click();
  await expect(page.getByRole('status')).toHaveText('Closed');
  await second.getByRole('button', { name: 'Retry opening' }).click();
  await expect(second.getByRole('status')).toHaveText('Ready');
  await expect(second.getByTestId('persisted-marker')).toHaveText('one writer');
});

test('closing the owning tab releases the worker lock and OPFS handles', async ({
  page,
  context
}) => {
  await ready(page);
  const second = await context.newPage();
  await second.goto('/sqlite-proof/');
  await expect(second.getByRole('status')).toHaveAttribute(
    'data-error-code',
    'databaseBusy'
  );
  await page.close();
  await second.getByRole('button', { name: 'Retry opening' }).click();
  await expect(second.getByRole('status')).toHaveText('Ready');
});
