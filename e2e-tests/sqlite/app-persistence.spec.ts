import type { Page } from '@playwright/test';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
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
  args: BrowserCommands[K]['args'],
  recoveryToken?: string
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
    { command, args, recoveryToken } as BrowserRequest
  ) as Promise<BrowserCommands[K]['result']>;
}
async function loadNoteTitled(page: Page, title: string) {
  const notes = await rpc(page, 'list_notes', {});
  const note = notes.find((candidate) => candidate.title === title);
  if (!note) throw new Error(`No note titled ${title}`);
  return rpc(page, 'load_note', { id: note.id });
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

for (const action of ['reload', 'close', 'source reload'] as const) {
  test(`edits survive immediate ${action} without waiting for autosave`, async ({
    page,
    context
  }) => {
    const title = `Immediate ${action} recovery`;
    const body = `Last keystroke before ${action} must survive`;
    await clickFileTreeCreateAction(page, 'New note');
    const draft = page.getByRole('textbox', { name: 'New note', exact: true });
    await draft.fill(title);
    await draft.press('Enter');
    await page
      .getByRole('group', { name: 'File tree' })
      .getByRole('button', { name: title, exact: true })
      .click();
    await expect(page.locator('.ProseMirror').first()).toBeVisible();
    const notes = await rpc(page, 'list_notes', {});
    const id = notes.find((note) => note.title === title)!.id;
    // Configure reload before editing. No save polling or debounce wait here.
    await page.route('**/*', (route) => route.continue());
    if (action === 'source reload') {
      const mode = page.getByRole('button', { name: /^Editor view mode:/ });
      for (
        let i = 0;
        i < 3 &&
        (await mode.getAttribute('aria-label')) !== 'Editor view mode: Source';
        i++
      )
        await mode.click();
      const source = page
        .locator('.cm-content[contenteditable="true"]')
        .first();
      await expect(source).toBeVisible();
      await source.fill(body);
    } else {
      await page.locator('.ProseMirror').first().fill(body);
    }
    let reopened = page;
    if (action === 'close') {
      await page.close();
      reopened = await context.newPage();
      await observeStorage(reopened);
      await boot(reopened);
    } else {
      await page.reload();
    }
    await reopened
      .getByRole('group', { name: 'File tree' })
      .getByRole('button', { name: title, exact: true })
      .click();
    await expect(reopened.locator('.ProseMirror').first()).toContainText(body);
    await expect
      .poll(async () => (await rpc(reopened, 'load_note', { id })).body)
      .toContain(body);
    await expect
      .poll(() =>
        reopened.evaluate(() =>
          Object.keys(localStorage).filter((key) =>
            key.startsWith('mindstream:browser-vault:draft:v1:')
          )
        )
      )
      .toEqual([]);
  });
}

test('handwritten strokes persist through normal saves and an immediate reload', async ({
  page
}) => {
  const title = 'Persistent handwriting';
  await clickFileTreeCreateAction(page, 'New handwritten note');
  const draft = page.getByRole('textbox', {
    name: 'New handwritten note',
    exact: true
  });
  await draft.fill(title);
  await draft.press('Enter');
  const canvas = page.getByLabel('Handwritten note canvas', { exact: true });
  await expect(canvas).toBeVisible();
  const id = (await loadNoteTitled(page, title)).id;
  const draw = async (offset: number) => {
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2 - 30, box.y + 100 + offset);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + 150 + offset, {
      steps: 8
    });
    await page.mouse.up();
  };
  const strokeCount = async () => {
    const note = await rpc(page, 'load_note', { id });
    const doc = new Y.Doc();
    try {
      if (note.yrs_state.length)
        Y.applyUpdate(doc, new Uint8Array(note.yrs_state));
      return doc.getArray('strokes').length;
    } finally {
      doc.destroy();
    }
  };
  await draw(0);
  // This waits for drawing_save_ink_state, proving the real save route works.
  await expect.poll(strokeCount).toBe(1);
  await page.route('**/*', (route) => route.continue());
  await draw(60);
  await page.reload();
  await page
    .getByRole('group', { name: 'File tree' })
    .getByRole('button', { name: title, exact: true })
    .click();
  await expect(canvas).toBeVisible();
  await expect.poll(strokeCount).toBe(2);
});

test('new typing restores when reload interrupts the acknowledgement of an earlier committed save', async ({
  page
}) => {
  const note = (await rpc(page, 'list_notes', {})).find(
    (note) => note.title === 'Welcome'
  )!;
  await page
    .getByRole('group', { name: 'File tree' })
    .getByRole('button', { name: 'Welcome', exact: true })
    .click();
  const editor = page.locator('.ProseMirror').first();
  await expect(editor).toBeVisible();
  await page.evaluate(() => {
    const state = window as unknown as {
      vaultWorker: Worker;
      heldSaveCommitted?: boolean;
    };
    const worker = state.vaultWorker;
    const originalSend = worker.postMessage.bind(worker);
    const originalReceive = worker.onmessage;
    let heldId: number | undefined;
    worker.postMessage = (message: {
      id: number;
      method: string;
      args?: { command?: string };
    }) => {
      if (
        !heldId &&
        message.method === 'invoke' &&
        message.args?.command === 'save_note'
      )
        heldId = message.id;
      originalSend(message);
    };
    // The real worker commits normally. Only its client acknowledgement is held.
    worker.onmessage = (event) => {
      if (event.data.id === heldId) {
        state.heldSaveCommitted = true;
        return;
      }
      originalReceive?.call(worker, event);
    };
  });
  await editor.fill('First committed save');
  await page.waitForFunction(
    () =>
      (window as unknown as { heldSaveCommitted?: boolean }).heldSaveCommitted
  );
  expect((await rpc(page, 'load_note', { id: note.id })).body).toContain(
    'First committed save'
  );
  await editor.fill('Second edit before the first acknowledgement');
  await page.reload();
  await page
    .getByRole('group', { name: 'File tree' })
    .getByRole('button', { name: 'Welcome', exact: true })
    .click();
  await expect(editor).toContainText(
    'Second edit before the first acknowledgement'
  );
  expect((await rpc(page, 'load_note', { id: note.id })).body).toContain(
    'Second edit before the first acknowledgement'
  );
  await expect(
    page.getByRole('button', { name: 'Download recovery copy', exact: true })
  ).toHaveCount(0);
});

test('a corrupt recovery entry keeps the vault usable and offers a retained copy', async ({
  page
}) => {
  await page.evaluate(() =>
    localStorage.setItem(
      'mindstream:browser-vault:draft:v1:corrupt-note',
      '{broken json'
    )
  );
  await hardReload(page);
  await expect(
    page
      .getByRole('group', { name: 'File tree' })
      .getByRole('button', { name: 'Welcome', exact: true })
  ).toBeVisible();
  const copy = page.getByRole('button', {
    name: 'Download recovery copy',
    exact: true
  });
  await expect(copy).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await copy.click();
  const download = await downloadEvent;
  const contents = await readFile((await download.path())!, 'utf8');
  expect(contents).toContain('{broken json');
  await hardReload(page);
  await expect(copy).toBeVisible();
});

test('stale recovery never overwrites a newer independently saved edit', async ({
  page
}) => {
  const note = (await rpc(page, 'list_notes', {})).find(
    (note) => note.title === 'Welcome'
  )!;
  await page
    .getByRole('group', { name: 'File tree' })
    .getByRole('button', { name: 'Welcome', exact: true })
    .click();
  await page.locator('.ProseMirror').first().fill('Older pending text');
  const key = `mindstream:browser-vault:draft:v1:${note.id}`;
  const raw = await page.evaluate((key) => localStorage.getItem(key), key);
  expect(raw).not.toBeNull();
  await expect
    .poll(async () => (await rpc(page, 'load_note', { id: note.id })).body)
    .toContain('Older pending text');
  // Reinstall the old record after a later independent write, as if its
  // acknowledgement had been interrupted before another writer saved.
  await hardReload(page);
  await rpc(page, 'save_note', {
    input: { id: note.id, body: 'Newer saved text' }
  });
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw!), {
    key,
    raw
  });
  await hardReload(page);
  await expect(
    page.getByRole('button', { name: 'Download recovery copy', exact: true })
  ).toBeVisible();
  expect((await rpc(page, 'load_note', { id: note.id })).body).toBe(
    'Newer saved text'
  );
  const copies = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith('mindstream:browser-vault:recovery:v1:'))
      .map((key) => localStorage.getItem(key))
  );
  expect(copies).toContain(raw);
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

test('the vault downloads as a zip holding its notes and attachment bytes', async ({
  page
}) => {
  const folder = await rpc(page, 'create_collection', {
    input: { name: 'Grüße' }
  });
  const note = await rpc(page, 'create_note', {
    input: { title: 'Reise nach Köln', parent_collection_id: folder.id }
  });
  const picture = [137, 80, 78, 71, 0, 255];
  const asset = await rpc(page, 'upload_drawing_asset', {
    input: {
      owning_note_id: note.id,
      mime_type: 'image/png',
      bytes: picture
    }
  });
  await rpc(page, 'save_note', {
    input: {
      id: note.id,
      body: `Am Dom.\n\n![photo](asset:mindstream/${asset.id})`
    }
  });
  const trashed = await rpc(page, 'create_note', {
    input: { title: 'Thrown away' }
  });
  await rpc(page, 'trash_note', { id: trashed.id });
  await hardReload(page);

  await page.getByRole('button', { name: 'Open settings' }).click();
  const settings = page.getByRole('dialog');
  await settings.getByRole('button', { name: /^Data/ }).first().click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    settings.getByRole('button', { name: 'Export vault' }).click()
  ]);
  expect(download.suggestedFilename()).toMatch(
    /^mindstream-notes-\d{4}-\d{2}-\d{2}\.zip$/
  );
  const files = unzipSync(
    new Uint8Array(await readFile(await download.path()))
  );

  const markdown = strFromU8(files['Grüße/Reise nach Köln.md']);
  expect(markdown).toContain('Am Dom.');
  expect(markdown).toContain(`_assets/${asset.id}.png`);
  expect(Array.from(files[`Grüße/_assets/${asset.id}.png`])).toEqual(picture);
  expect(Object.keys(files).join()).not.toContain('Thrown away');
  await expect(page.getByText('Saved to')).toHaveCount(0);
});

test('a backup downloads in the native format and leaves browser state out', async ({
  page
}) => {
  const note = await rpc(page, 'create_note', {
    input: { title: 'Backed up note' }
  });
  await rpc(
    page,
    'save_note',
    { input: { id: note.id, body: 'Kept safe' } },
    'a-save-receipt'
  );
  await rpc(page, 'upload_drawing_asset', {
    input: {
      owning_note_id: note.id,
      mime_type: 'image/png',
      bytes: [137, 80, 78, 71, 0, 255]
    }
  });

  await page.getByRole('button', { name: 'Open settings' }).click();
  const settings = page.getByRole('dialog');
  await settings.getByRole('button', { name: /^Data/ }).first().click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    settings.getByRole('button', { name: 'Back up now' }).click()
  ]);
  expect(download.suggestedFilename()).toMatch(
    /^mindstream-backup-[\dT-]+\.zip$/
  );
  // Regenerates src-tauri/src/backup/fixtures/browser-backup.zip when set.
  const fixture = process.env.BROWSER_BACKUP_FIXTURE;
  if (fixture) await download.saveAs(fixture);

  const files = unzipSync(
    new Uint8Array(await readFile(await download.path()))
  );
  expect(Object.keys(files)).toEqual(['manifest.json', 'data.db']);
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  expect(manifest).toMatchObject({
    format_version: 1,
    account_present_at_export: false,
    contents: { db_filename: 'data.db', counts: { assets_bytes: 6 } }
  });
  expect(manifest.portable).toBeUndefined();
  expect(manifest.data_db_sha256).toBe(
    createHash('sha256').update(files['data.db']).digest('hex')
  );

  const directory = await mkdtemp(join(tmpdir(), 'browser-backup-'));
  try {
    const database = join(directory, 'data.db');
    await writeFile(database, files['data.db']);
    const snapshot = new DatabaseSync(database, { readOnly: true });
    const row = snapshot
      .prepare('SELECT body FROM notes WHERE id = ?')
      .get(note.id) as { body: string };
    const tables = snapshot
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const version = snapshot.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    snapshot.close();
    expect(row.body).toBe('Kept safe');
    expect(tables.map(({ name }) => name)).not.toContain(
      'browser_write_receipts'
    );
    expect(version.user_version).toBe(manifest.schema_version);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  // The vault stays usable, and the snapshot's pool file is free to reuse.
  expect((await rpc(page, 'load_note', { id: note.id })).body).toBe(
    'Kept safe'
  );
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  const [second] = await Promise.all([
    page.waitForEvent('download'),
    settings.getByRole('button', { name: 'Back up now' }).click()
  ]);
  expect(second.suggestedFilename()).toMatch(/^mindstream-backup-/);
});

// A backup the native app wrote, with its plugin package, plugin data and
// settings. A browser restores the database and leaves those behind.
const NATIVE_BACKUP = fileURLToPath(
  new URL('fixtures/native-backup.zip', import.meta.url)
);

async function openDataSettings(page: Page) {
  await page.getByRole('button', { name: 'Open settings' }).click();
  const settings = page.getByRole('dialog');
  await settings.getByRole('button', { name: /^Data/ }).first().click();
  return settings;
}

async function chooseBackup(
  page: Page,
  file: string | { name: string; mimeType: string; buffer: Buffer }
) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page
      .getByRole('dialog')
      .getByRole('button', { name: 'Restore from backup' })
      .click()
  ]);
  await chooser.setFiles(file);
}

async function noteTitles(page: Page) {
  const notes = await rpc(page, 'list_notes', {});
  return notes.map((note) => note.title);
}

async function replaceVault(page: Page) {
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Restore this vault' }).click();
  await expect(dialog).toContainText('downloads first');
  const [safety] = await Promise.all([
    page.waitForEvent('download'),
    page.waitForEvent('load'),
    dialog.getByRole('button', { name: 'Replace vault' }).click()
  ]);
  await page.waitForFunction(() => 'vaultWorker' in window);
  return safety;
}

test('a native backup replaces the vault after saving a copy of it', async ({
  page
}) => {
  await rpc(page, 'create_note', { input: { title: 'Before the restore' } });
  await openDataSettings(page);
  await chooseBackup(page, NATIVE_BACKUP);
  const safety = await replaceVault(page);

  const tree = page.getByRole('group', { name: 'File tree' });
  await expect(
    tree.getByRole('button', { name: 'Portable note', exact: true })
  ).toBeVisible({ timeout: 20_000 });
  expect(await noteTitles(page)).not.toContain('Before the restore');

  // The replaced notes are in the file the user was handed.
  const files = unzipSync(new Uint8Array(await readFile(await safety.path())));
  const directory = await mkdtemp(join(tmpdir(), 'safety-backup-'));
  try {
    const database = join(directory, 'data.db');
    await writeFile(database, files['data.db']);
    const snapshot = new DatabaseSync(database, { readOnly: true });
    const titles = snapshot.prepare('SELECT title FROM notes').all() as {
      title: string;
    }[];
    snapshot.close();
    expect(titles.map(({ title }) => title)).toContain('Before the restore');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  await hardReload(page);
  expect(await noteTitles(page)).toContain('Portable note');
});

test('merging a native backup adds its notes and keeps the vault', async ({
  page
}) => {
  await rpc(page, 'create_note', {
    input: { title: 'Kept through the merge' }
  });
  await openDataSettings(page);
  await chooseBackup(page, NATIVE_BACKUP);
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Merge missing items' }).click();
  await expect(dialog).toContainText('Merge complete');
  expect(await noteTitles(page)).toEqual(
    expect.arrayContaining(['Kept through the merge', 'Portable note'])
  );
});

test('a browser backup restores the vault it came from', async ({ page }) => {
  const note = await rpc(page, 'create_note', {
    input: { title: 'Original title' }
  });
  const settings = await openDataSettings(page);
  const [backup] = await Promise.all([
    page.waitForEvent('download'),
    settings.getByRole('button', { name: 'Back up now' }).click()
  ]);
  const path = await backup.path();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await rpc(page, 'save_note', { input: { id: note.id, title: 'Renamed' } });

  await chooseBackup(page, path);
  await replaceVault(page);
  const titles = await noteTitles(page);
  expect(titles).toContain('Original title');
  expect(titles).not.toContain('Renamed');
});

test('a file that is not a sound backup leaves the vault alone', async ({
  page
}) => {
  await rpc(page, 'create_note', { input: { title: 'Still here' } });
  await openDataSettings(page);
  const refusal = page.getByRole('alertdialog');

  await chooseBackup(page, {
    name: 'holiday-photos.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('this is not a zip')
  });
  await expect(refusal).toContainText('not a Mindstream backup');
  await refusal.getByRole('button', { name: 'OK' }).click();

  const original = unzipSync(new Uint8Array(await readFile(NATIVE_BACKUP)));
  original['data.db'] = original['data.db'].slice();
  original['data.db'][4096] ^= 0xff;
  await chooseBackup(page, {
    name: 'tampered.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zipSync(original))
  });
  await expect(refusal).toContainText('checksum mismatch');
  await refusal.getByRole('button', { name: 'OK' }).click();

  expect(await noteTitles(page)).toContain('Still here');
  expect(await noteTitles(page)).not.toContain('Portable note');
});

async function importNotes(
  page: Page,
  choice: string,
  files: string | { name: string; mimeType: string; buffer: Buffer }
) {
  const settings = await openDataSettings(page);
  await settings
    .getByRole('button', { name: 'Import notes', exact: true })
    .click();
  const dialog = page.getByRole('alertdialog');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    dialog.getByRole('button', { name: new RegExp(choice) }).click()
  ]);
  await chooser.setFiles(files);
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).toContainText('Import finished', { timeout: 20_000 });
}

test('a folder of notes imports with its links and attachments', async ({
  page
}) => {
  const vault = await mkdtemp(join(tmpdir(), 'Köln-vault-'));
  try {
    await mkdir(join(vault, '.obsidian'));
    await mkdir(join(vault, 'Reise'));
    await mkdir(join(vault, 'pics'));
    await writeFile(join(vault, '.obsidian', 'app.json'), '{}');
    await writeFile(
      join(vault, 'Start.md'),
      'Weiter zu [[Köln]] und ![[dom.png]]'
    );
    await writeFile(join(vault, 'Reise', 'Köln.md'), 'Zurück zu [[Start]]');
    const picture = Buffer.from([137, 80, 78, 71, 0, 255]);
    await writeFile(join(vault, 'pics', 'dom.png'), picture);

    await importNotes(page, 'Choose a folder', vault);

    const start = await loadNoteTitled(page, 'Start');
    const city = await loadNoteTitled(page, 'Köln');
    expect(start.body).toContain(city.id);
    expect(city.body).toContain(start.id);
    const asset = /asset:mindstream\/([\w-]+)/.exec(start.body)?.[1];
    expect(asset).toBeTruthy();
    expect(
      (await rpc(page, 'fetch_drawing_asset', { id: asset! })).bytes
    ).toEqual(Array.from(picture));
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('stopping an import keeps what it committed and the vault stays usable', async ({
  page
}) => {
  const before = (await noteTitles(page)).length;
  // Large enough that Stop lands before the run ends, even in a fast browser.
  const total = 5_000;
  const vault = await mkdtemp(join(tmpdir(), 'large-vault-'));
  try {
    await Promise.all(
      Array.from({ length: total }, (_, index) =>
        writeFile(join(vault, `Note ${index}.md`), `Body ${index}`)
      )
    );
    const settings = await openDataSettings(page);
    await settings
      .getByRole('button', { name: 'Import notes', exact: true })
      .click();
    const dialog = page.getByRole('alertdialog');
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      dialog.getByRole('button', { name: /Choose a folder/ }).click()
    ]);
    await chooser.setFiles(vault);
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();

    await expect(dialog).toContainText(/Imported \d+ of 5000/, {
      timeout: 30_000
    });
    await dialog.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(dialog).toContainText('Import stopped', { timeout: 20_000 });

    // Batches commit 500 notes at a time, and the one in flight rolls back.
    await page.waitForFunction(() => 'vaultWorker' in window);
    await expect
      .poll(
        async () =>
          noteTitles(page).then(
            (titles) => titles.length - before,
            () => -1
          ),
        { timeout: 30_000 }
      )
      .toBeGreaterThanOrEqual(500);
    const added = (await noteTitles(page)).length - before;
    expect(added % 500).toBe(0);
    expect(added).toBeLessThan(total);
    expect((await loadNoteTitled(page, 'Note 0')).body).toContain('Body 0');
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('an Evernote export imports from one file', async ({ page }) => {
  const enex =
    '<?xml version="1.0" encoding="UTF-8"?><en-export><note><title>Aus Evernote</title>' +
    '<content><![CDATA[<en-note>Am <b>Rhein</b></en-note>]]></content>' +
    '<created>20240102T101500Z</created></note></en-export>';
  await importNotes(page, 'Choose a file', {
    name: 'export.enex',
    mimeType: 'application/xml',
    buffer: Buffer.from(enex)
  });
  expect((await loadNoteTitled(page, 'Aus Evernote')).body).toContain('Rhein');
});

// A tar holds each file behind a 512-byte header, padded to 512-byte blocks.
function tarOf(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0' + '00', 257);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, body, Buffer.alloc(-body.length & 511));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

test('a Joplin archive imports from one file with its links', async ({
  page
}) => {
  const first = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
  const second = '1b2c3d4e5f60718293a4b5c6d7e8f9a0';
  const item = (title: string, target: string, id: string) =>
    `${title}\n\nSiehe [Link](:/${target}).\n\nid: ${id}\ntype_: 1\n`;
  await importNotes(page, 'Choose a file', {
    name: 'export.jex',
    mimeType: 'application/octet-stream',
    buffer: tarOf({
      [`${first}.md`]: item('Erste Notiz', second, first),
      [`${second}.md`]: item('Zweite Notiz', first, second)
    })
  });
  const one = await loadNoteTitled(page, 'Erste Notiz');
  const two = await loadNoteTitled(page, 'Zweite Notiz');
  expect(one.body).toContain(two.id);
  expect(two.body).toContain(one.id);
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
