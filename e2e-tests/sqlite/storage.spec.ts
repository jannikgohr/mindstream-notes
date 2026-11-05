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
  // The proof in the worker fails, and `ready` with it, unless the database
  // reaches the latest schema and every older version upgrades to it. So no
  // version numbers here to keep in step with the migrations.
  await ready(page);
  const report = JSON.parse(await page.getByTestId('proof-report').innerText());
  expect(report).toMatchObject({
    journalMode: 'delete',
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

test('a terminated worker rolls back cache-spilled uncommitted pages from its hot journal', async ({
  page
}) => {
  await page.addInitScript(() => {
    const Original = window.Worker;
    window.Worker = class extends Original {
      postMessage(message: unknown, options?: StructuredSerializeOptions) {
        const request = message as { method?: string; args?: unknown };
        if (request.method === 'open' && request.args === undefined)
          (window as unknown as { proofWorker: Worker }).proofWorker = this;
        super.postMessage(message, options);
      }
    };
  });
  await ready(page);
  const request = async (
    method: 'prepareInterruptedWrite' | 'checkInterruptedWrite'
  ) =>
    page.evaluate(async (method) => {
      const worker = (window as unknown as { proofWorker: Worker }).proofWorker;
      const id = 100000 + Math.floor(Math.random() * 100000);
      return new Promise<number | undefined>((resolve, reject) => {
        const receive = (event: MessageEvent) => {
          if (event.data.id !== id) return;
          worker.removeEventListener('message', receive);
          if (event.data.ok) resolve(event.data.result);
          else reject(event.data.error);
        };
        worker.addEventListener('message', receive);
        worker.postMessage({ id, method, args: undefined });
      });
    }, method);
  await request('prepareInterruptedWrite');
  // The transaction is still open and has spilled dirty database pages. Do not
  // call close, which would roll it back normally, or wait for a commit.
  await page.evaluate(() =>
    (window as unknown as { proofWorker: Worker }).proofWorker.terminate()
  );
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Ready');
  expect(await request('checkInterruptedWrite')).toBe(300);
});
