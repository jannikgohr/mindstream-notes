import type { Page } from '@playwright/test';
import { test, expect } from '../sqlite/fixtures';
import { vaultNamespace } from '../../src/lib/browser/namespace';
import type { Note, NoteSummary } from '../../src/lib/api/notes';

async function observe(page: Page) {
  await page.addInitScript(() => {
    const Original = window.Worker;
    window.Worker = class extends Original {
      private address: string;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.address = String(url);
      }
      postMessage(message: unknown, options?: StructuredSerializeOptions) {
        const raw = message as {
          method?: string;
          args?: { scope?: string; testId?: string };
        };
        if (
          (raw.method === 'open' || raw.method === 'resetTestVault') &&
          raw.args?.testId === 'qa'
        ) {
          const state = window as unknown as {
            qaWorker: Worker;
            storageWorkerUrl: string;
          };
          state.qaWorker = this;
          state.storageWorkerUrl = this.address;
        }
        super.postMessage(message, options);
      }
    };
  });
}
async function boot(page: Page) {
  await page.goto('/');
  if (test.info().project.name === 'webkit')
    test.skip(
      !(await page.evaluate(
        () => typeof navigator.storage?.getDirectory === 'function'
      )),
      'This WebKit has no OPFS API'
    );
  await expect(
    page
      .getByRole('group', { name: 'File tree' })
      .getByRole('button', { name: 'Welcome', exact: true })
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByRole('complementary', { name: 'Browser testing' })
  ).toContainText('Test vault: qa');
}
async function rpc(
  page: Page,
  target: string,
  command: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return page.evaluate(
    async ({ target, command, args }) => {
      const state = window as unknown as {
        qaWorker: Worker;
        auxWorkers: Record<string, Worker>;
      };
      const worker =
        target === 'qa' ? state.qaWorker : state.auxWorkers[target];
      const id = 100000 + Math.floor(Math.random() * 100000000);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Storage request timed out')),
          10000
        );
        const receive = (event: MessageEvent) => {
          if (event.data.id !== id) return;
          clearTimeout(timer);
          worker.removeEventListener('message', receive);
          if (event.data.ok) resolve(event.data.result);
          else reject(event.data.error);
        };
        worker.addEventListener('message', receive);
        worker.postMessage({ id, method: 'invoke', args: { command, args } });
      });
    },
    { target, command, args }
  );
}
async function openAux(page: Page, target: string, testId?: string) {
  await page.evaluate(
    async ({ target, testId }) => {
      const state = window as unknown as {
        storageWorkerUrl: string;
        auxWorkers?: Record<string, Worker>;
      };
      const worker = new Worker(state.storageWorkerUrl, { type: 'module' });
      state.auxWorkers ??= {};
      state.auxWorkers[target] = worker;
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = (event) => {
          worker.onmessage = null;
          if (event.data.ok) resolve();
          else reject(event.data.error);
        };
        worker.postMessage({
          id: 1,
          method: 'open',
          args: { scope: 'vault', ...(testId ? { testId } : {}) }
        });
      });
    },
    { target, testId }
  );
}
async function closeAux(page: Page, target: string) {
  await page.evaluate(async (target) => {
    const worker = (window as unknown as { auxWorkers: Record<string, Worker> })
      .auxWorkers[target];
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (event) => {
        worker.onmessage = null;
        if (event.data.ok) resolve();
        else reject(event.data.error);
      };
      worker.postMessage({ id: 2, method: 'close', args: undefined });
    });
    worker.terminate();
  }, target);
}

test.beforeEach(async ({ page }) => {
  await observe(page);
  await boot(page);
});

test('QA edits survive reload, then reset seeds only the selected test vault', async ({
  page
}) => {
  const initial = (
    (await rpc(page, 'qa', 'list_notes', {})) as NoteSummary[]
  ).find((note) => note.title === 'Welcome')!;
  const original = (await rpc(page, 'qa', 'load_note', {
    id: initial.id
  })) as Note;
  // Concurrently open the normal vault and another test vault on this origin.
  await openAux(page, 'normal');
  await openAux(page, 'other', 'other');
  const normal = (await rpc(page, 'normal', 'create_note', {
    input: { title: 'Normal data must remain', body: 'normal content' }
  })) as Note;
  const other = (await rpc(page, 'other', 'create_note', {
    input: { title: 'Other QA must remain', body: 'other content' }
  })) as Note;
  await closeAux(page, 'normal');
  await closeAux(page, 'other');
  const qaOnly = (await rpc(page, 'qa', 'create_note', {
    input: { title: 'Disposable QA note', body: 'QA content' }
  })) as Note;
  await page.reload();
  await page
    .getByRole('group', { name: 'File tree' })
    .getByRole('button', { name: 'Welcome', exact: true })
    .click();
  await page
    .locator('.ProseMirror')
    .first()
    .fill('Discard this pending QA edit');
  const scopes = [
    vaultNamespace(),
    vaultNamespace('other'),
    vaultNamespace('qa')
  ];
  await page.evaluate((scopes) => {
    for (const names of scopes) {
      localStorage.setItem(names.archive + 'sentinel', 'retained copy');
      if (names.reset === undefined || names.reset.includes(':other:'))
        localStorage.setItem(names.draft + 'sentinel', 'pending copy');
    }
  }, scopes);
  await Promise.all([
    page.waitForEvent('load'),
    page.getByRole('button', { name: 'Reset test data', exact: true }).click()
  ]);
  await expect(
    page
      .getByRole('group', { name: 'File tree' })
      .getByRole('button', { name: 'Welcome', exact: true })
  ).toBeVisible({ timeout: 20_000 });
  const after = (await rpc(page, 'qa', 'list_notes', {})) as NoteSummary[];
  expect(after.some((note) => note.id === qaOnly.id)).toBe(false);
  expect(
    ((await rpc(page, 'qa', 'load_note', { id: initial.id })) as Note).body
  ).toBe(original.body);
  const copies = await page.evaluate(() =>
    Object.fromEntries(
      Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])
    )
  );
  for (const [key, value] of Object.entries(copies)) {
    if (key.startsWith(vaultNamespace('qa').draft))
      expect(value).not.toContain('Discard this pending QA edit');
    expect(key.startsWith(vaultNamespace('qa').archive)).toBe(false);
  }
  // Restored editor tabs can checkpoint freshly seeded content during mount.
  // Those new snapshots may exist briefly, but no discarded draft may return.
  await expect
    .poll(() =>
      page.evaluate(
        (prefix) =>
          Object.keys(localStorage).filter((key) => key.startsWith(prefix)),
        vaultNamespace('qa').draft
      )
    )
    .toEqual([]);
  const local = Object.keys(copies);
  for (const names of scopes.slice(0, 2)) {
    expect(local).toContain(names.draft + 'sentinel');
    expect(local).toContain(names.archive + 'sentinel');
  }
  await openAux(page, 'normal');
  await openAux(page, 'other', 'other');
  expect(
    ((await rpc(page, 'normal', 'load_note', { id: normal.id })) as Note).body
  ).toBe('normal content');
  expect(
    ((await rpc(page, 'other', 'load_note', { id: other.id })) as Note).body
  ).toBe('other content');
  await closeAux(page, 'normal');
  await closeAux(page, 'other');
  await page.reload();
  await expect(
    page
      .getByRole('group', { name: 'File tree' })
      .getByRole('button', { name: 'Welcome', exact: true })
  ).toBeVisible();
  const final = (await rpc(page, 'qa', 'load_note', {
    id: initial.id
  })) as Note;
  expect(final.body).toContain(original.body.split('\n')[0]);
  expect(final.body).not.toContain('Discard this pending QA edit');
});

test('a second tab cannot reset a vault while its owner is active', async ({
  page,
  context
}) => {
  const note = (await rpc(page, 'qa', 'create_note', {
    input: { title: 'Owned test data', body: 'keep while owned' }
  })) as Note;
  const second = await context.newPage();
  await observe(second);
  await second.goto('/');
  await expect(
    second.getByText(/The database is open in another tab/)
  ).toBeVisible({ timeout: 20_000 });
  await Promise.all([
    second.waitForEvent('load'),
    second.getByRole('button', { name: 'Reset test data', exact: true }).click()
  ]);
  await expect(
    second.getByText(/The database is open in another tab/)
  ).toBeVisible({ timeout: 20_000 });
  expect(
    ((await rpc(page, 'qa', 'load_note', { id: note.id })) as Note).body
  ).toBe('keep while owned');
  await second.close();
});
