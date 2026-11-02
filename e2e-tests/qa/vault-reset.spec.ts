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
          sessionStorage.setItem('qa-worker-url', this.address);
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
      const worker = new Worker(
        state.storageWorkerUrl || sessionStorage.getItem('qa-worker-url')!,
        { type: 'module' }
      );
      state.auxWorkers ??= {};
      state.auxWorkers[target] = worker;
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = (event) => {
          worker.onmessage = null;
          if (event.data.ok) resolve();
          else {
            worker.terminate();
            reject(event.data.error);
          }
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
  await expect
    .poll(() =>
      page.evaluate(
        (key) => localStorage.getItem(key),
        vaultNamespace('qa').draft + initial.id
      )
    )
    .toContain('Discard this pending QA edit');
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
  // Check after the editor has settled as well as immediately after reset.
  await expect
    .poll(() =>
      page.evaluate(
        (prefix) =>
          Object.keys(localStorage).filter((key) => key.startsWith(prefix)),
        vaultNamespace('qa').draft
      )
    )
    .toEqual([]);
  expect(
    ((await rpc(page, 'qa', 'load_note', { id: initial.id })) as Note).body
  ).toBe(original.body);
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
  expect(final.body).toBe(original.body);
  expect(final.body).not.toContain('Discard this pending QA edit');
});

test('a refused reset blocks startup until an explicit retry, even after the owner leaves', async ({
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
    second.getByText(/Test data reset failed.*Notes have not been loaded/)
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    second
      .getByRole('group', { name: 'File tree' })
      .getByRole('button', { name: 'Welcome', exact: true })
  ).toHaveCount(0);
  expect(
    ((await rpc(page, 'qa', 'load_note', { id: note.id })) as Note).body
  ).toBe('keep while owned');
  const later = (await rpc(page, 'qa', 'create_note', {
    input: { title: 'Work after refusal', body: 'must not be silently erased' }
  })) as Note;
  await page.close();
  await second.reload();
  await expect(
    second.getByText(/Test data reset failed.*Notes have not been loaded/)
  ).toBeVisible();
  // Startup stays blocked rather than claiming ownership and wiping later work.
  await expect(() => openAux(second, 'inspection', 'qa')).toPass({
    timeout: 10_000
  });
  expect(
    ((await rpc(second, 'inspection', 'load_note', { id: later.id })) as Note)
      .body
  ).toBe('must not be silently erased');
  await closeAux(second, 'inspection');
  await Promise.all([
    second.waitForEvent('load'),
    second.getByRole('button', { name: 'Reset test data', exact: true }).click()
  ]);
  await expect(
    second
      .getByRole('group', { name: 'File tree' })
      .getByRole('button', { name: 'Welcome', exact: true })
  ).toBeVisible({ timeout: 20_000 });
  const resetNotes = (await rpc(
    second,
    'qa',
    'list_notes',
    {}
  )) as NoteSummary[];
  expect(resetNotes.some((n) => n.id === later.id || n.id === note.id)).toBe(
    false
  );
  await second.close();
});

test('opening an unedited seeded note does not rewrite its content or modified time', async ({
  page
}) => {
  const initial = (
    (await rpc(page, 'qa', 'list_notes', {})) as NoteSummary[]
  ).find((n) => n.title === 'Welcome')!;
  const before = await rpc(page, 'qa', 'load_note', { id: initial.id });
  await page
    .getByRole('group', { name: 'File tree' })
    .getByRole('button', { name: 'Welcome', exact: true })
    .click();
  await expect(page.locator('.ProseMirror').first()).toBeVisible();
  await page.locator('.ProseMirror').first().click();
  // Cross the editor's debounce so a mount-triggered save cannot evade the check.
  await page.waitForTimeout(2500);
  expect(await rpc(page, 'qa', 'load_note', { id: initial.id })).toEqual(
    before
  );
  // Legacy bodies still upgrade to the editor's v2 state on the first edit.
  await page.locator('.ProseMirror').first().press('ControlOrMeta+End');
  await page.locator('.ProseMirror').first().press('Enter');
  await page
    .locator('.ProseMirror')
    .first()
    .pressSequentially('First actual edit');
  await expect
    .poll(async () => {
      const saved = (await rpc(page, 'qa', 'load_note', {
        id: initial.id
      })) as Note;
      return {
        schema: saved.payload_schema,
        edited: saved.body.includes('First actual edit')
      };
    })
    .toEqual({ schema: 2, edited: true });
});
