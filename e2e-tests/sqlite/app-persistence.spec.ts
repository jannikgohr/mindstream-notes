import type { Page } from '@playwright/test';
import * as Y from 'yjs';
import { test, expect } from './fixtures';
import { clickFileTreeCreateAction } from '../browser/file-tree-toolbar';
import type {
  BrowserCommand,
  BrowserCommands,
  BrowserRequest
} from '../../src/lib/browser/commands';

// Observe the real app worker. Test requests use a separate ID range and the
// shipped protocol; storage, SQL, and responses are never mocked.
async function observeStorage(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message: unknown, options?: StructuredSerializeOptions) {
        const raw = message as { method?: string; args?: { scope?: string } };
        if (raw.method === 'open' && raw.args?.scope === 'vault') {
          (window as unknown as { vaultWorker: Worker }).vaultWorker = this;
        }
        super.postMessage(message, options);
      }
    };
  });
}
async function rpc<K extends BrowserCommand>(
  page: Page,
  command: K,
  args: BrowserCommands[K]['args']
): Promise<BrowserCommands[K]['result']> {
  return page.evaluate(
    async (request: BrowserRequest) => {
      const worker = (window as unknown as { vaultWorker: Worker }).vaultWorker;
      if (!worker) throw new Error('The app did not open its vault worker');
      const id = Math.floor(Math.random() * 1_000_000_000) + 10_000;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          worker.removeEventListener('message', receive);
          reject(new Error('Vault test request timed out'));
        }, 10_000);
        const receive = (event: MessageEvent) => {
          if (event.data.id !== id) return;
          clearTimeout(timer);
          worker.removeEventListener('message', receive);
          if (event.data.ok) resolve(event.data.result);
          else reject(event.data.error);
        };
        worker.addEventListener('message', receive);
        worker.postMessage({ id, method: 'invoke', args: request });
      });
    },
    { command, args } as BrowserRequest
  ) as Promise<BrowserCommands[K]['result']>;
}
async function boot(page: Page) {
  await page.goto('/');
  if (test.info().project.name === 'webkit') {
    test.skip(
      !(await page.evaluate(
        () => typeof navigator.storage?.getDirectory === 'function'
      )),
      'This WebKit build has no OPFS API'
    );
  }
  await expect(
    page
      .getByRole('group', { name: 'File tree' })
      .getByRole('button', { name: 'Welcome', exact: true })
  ).toBeVisible({ timeout: 20_000 });
}
async function hardReload(page: Page) {
  // Enabling passthrough request routing disables the browser HTTP cache.
  await page.route('**/*', (route) => route.continue());
  await page.reload();
  await expect(page.getByRole('group', { name: 'File tree' })).toBeVisible();
  await page.waitForFunction(() => 'vaultWorker' in window);
}

test.beforeEach(async ({ page }) => {
  await observeStorage(page);
  await boot(page);
});

test('a note created and edited in the app survives hard reload and closing its tab', async ({
  page,
  context
}) => {
  const title = 'Saved across a hard reload';
  const body = 'Editor text must survive a cache-disabled reload 🔒';
  await clickFileTreeCreateAction(page, 'New note');
  const draft = page.getByRole('textbox', { name: 'New note', exact: true });
  await draft.fill(title);
  await draft.press('Enter');
  const item = page
    .getByRole('group', { name: 'File tree' })
    .getByRole('button', { name: title, exact: true });
  await item.click();
  const editor = page.locator('.ProseMirror').first();
  await expect(editor).toBeVisible();
  await editor.fill(body);
  const notes = await rpc(page, 'list_notes', {});
  const id = notes.find((note) => note.title === title)!.id;
  await expect
    .poll(async () => (await rpc(page, 'load_note', { id })).body)
    .toContain(body);
  await hardReload(page);
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator('.ProseMirror').first()).toContainText(body);
  await expect
    .poll(async () => (await rpc(page, 'load_note', { id })).body)
    .toContain(body);
  await page.close();
  const reopened = await context.newPage();
  await observeStorage(reopened);
  await boot(reopened);
  await reopened
    .getByRole('group', { name: 'File tree' })
    .getByRole('button', { name: title, exact: true })
    .click();
  await expect(reopened.locator('.ProseMirror').first()).toContainText(body);
});

test('folders, metadata, attachment bytes, history, and editor CRDT state persist together', async ({
  page
}) => {
  const folder = await rpc(page, 'create_collection', {
    input: { name: 'Persistent folder' }
  });
  const note = await rpc(page, 'create_note', {
    input: { title: 'Persistent document', parent_collection_id: folder.id }
  });
  const asset = await rpc(page, 'upload_drawing_asset', {
    input: {
      owning_note_id: note.id,
      mime_type: 'image/png',
      bytes: [137, 80, 78, 71, 0, 255]
    }
  });
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph');
  const text = new Y.XmlText();
  text.insert(0, 'Persistent document text');
  paragraph.insert(0, [text]);
  doc.getXmlFragment('prosemirror').insert(0, [paragraph]);
  const state = Array.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  const body = `Persistent document text\n\n![image](asset:mindstream/${asset.id})`;
  await rpc(page, 'save_note', {
    input: {
      id: note.id,
      body,
      yrs_state: state,
      tags: ['durable'],
      favourite: true,
      parent_collection_id: undefined
    }
  });
  await rpc(page, 'capture_current_note_version', {
    noteId: note.id,
    action: 'created',
    refVersionId: null
  });
  await hardReload(page);
  const loaded = await rpc(page, 'load_note', { id: note.id });
  expect(loaded).toMatchObject({
    body,
    parent_collection_id: folder.id,
    tags: ['durable'],
    favourite: true,
    payload_schema: 2,
    yrs_state: state
  });
  expect(
    (await rpc(page, 'fetch_drawing_asset', { id: asset.id })).bytes
  ).toEqual([137, 80, 78, 71, 0, 255]);
  expect(
    await rpc(page, 'list_note_versions', { noteId: note.id })
  ).toHaveLength(1);
  expect(
    (await rpc(page, 'search_notes', { query: 'Persistent document' })).some(
      (hit) => hit.note.id === note.id
    )
  ).toBe(true);
  await expect(
    page
      .getByRole('group', { name: 'File tree' })
      .getByRole('button', { name: folder.name, exact: true })
  ).toBeVisible();
  await rpc(page, 'trash_many', { items: [{ kind: 'folder', id: folder.id }] });
  await hardReload(page);
  expect(
    (await rpc(page, 'list_notes', {})).some((item) => item.id === note.id)
  ).toBe(false);
  expect(await rpc(page, 'trash_counts', {})).toMatchObject({
    notes: 1,
    folders: 1
  });
  await rpc(page, 'restore_many', {
    items: [{ kind: 'folder', id: folder.id }]
  });
  await hardReload(page);
  expect((await rpc(page, 'load_note', { id: note.id })).body).toBe(body);
});

test('another tab reports the database owner and opens persisted data after it closes', async ({
  page,
  context
}) => {
  const note = await rpc(page, 'create_note', {
    input: { title: 'One owner', body: 'Committed before the other tab opens' }
  });
  const second = await context.newPage();
  await observeStorage(second);
  await second.goto('/');
  await expect(
    second.getByText(
      'The database is open in another tab. Close it there and retry.',
      { exact: false }
    )
  ).toBeVisible();
  await page.close();
  await second.reload();
  await expect(
    second
      .getByRole('group', { name: 'File tree' })
      .getByRole('button', { name: note.title, exact: true })
  ).toBeVisible();
  expect((await rpc(second, 'load_note', { id: note.id })).body).toBe(
    note.body
  );
});
