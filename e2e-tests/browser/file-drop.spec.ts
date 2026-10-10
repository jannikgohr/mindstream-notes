import { expect, test, type Locator, type Page } from '@playwright/test';
import { clickFileTreeCreateAction } from './file-tree-toolbar';

/**
 * Files dragged in from the OS, in browser-fallback mode (T2).
 *
 * A dropped file has three possible destinations — the editor under the
 * pointer, the folder under the pointer, or a new PDF note at the vault root —
 * and the window-level router in src/lib/file-drop.ts picks one. These tests
 * drive real `dragover`/`drop` events through that router and through the
 * editors' own drop handlers (ProseMirror, Excalidraw), which is the part unit
 * tests can't reach.
 *
 * The drags are synthetic: Playwright can't start an OS drag, so each test
 * builds a `DataTransfer` in the page and dispatches the events itself.
 */

interface DroppedFile {
  name: string;
  type: string;
  bytes: number[];
}

// 1×1 transparent PNG.
const PNG_BYTES = Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  )
);

// Smallest document pdf.js will open: one empty page, no xref table.
const PDF_BYTES = Array.from(
  Buffer.from(
    [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
      'trailer<</Root 1 0 R>>',
      '%%EOF'
    ].join('\n')
  )
);

const png = (name = 'photo.png'): DroppedFile => ({
  name,
  type: 'image/png',
  bytes: PNG_BYTES
});
const pdf = (name: string): DroppedFile => ({
  name,
  type: 'application/pdf',
  bytes: PDF_BYTES
});

const UNSUPPORTED = 'Nothing here can use those files.';

async function boot(page: Page) {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Welcome', exact: true })
  ).toBeVisible();
}

function fileTree(page: Page): Locator {
  return page.getByRole('group', { name: 'File tree' });
}

function treeItem(page: Page, name: string): Locator {
  return fileTree(page).getByRole('button', { name, exact: true });
}

/** Drop `files` on the centre of `target`, the way an OS drag would. */
async function dropFiles(page: Page, target: Locator, files: DroppedFile[]) {
  const box = (await target.boundingBox())!;
  // ProseMirror resolves the drop position from the pointer coordinates and
  // ignores a drop it can't place, so the events need real ones.
  const point = {
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2
  };
  const dataTransfer = await page.evaluateHandle((dropped) => {
    const transfer = new DataTransfer();
    for (const file of dropped) {
      transfer.items.add(
        new File([new Uint8Array(file.bytes)], file.name, { type: file.type })
      );
    }
    return transfer;
  }, files);
  await target.dispatchEvent('dragover', { dataTransfer, ...point });
  await target.dispatchEvent('drop', { dataTransfer, ...point });
}

async function openWelcomeNote(page: Page): Promise<Locator> {
  await treeItem(page, 'Welcome').click();
  const editor = page.locator('.milkdown .ProseMirror');
  await expect(editor).toBeVisible();
  return editor;
}

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('an image dropped on a markdown note is inserted into it', async ({
  page
}) => {
  const editor = await openWelcomeNote(page);
  const images = editor.locator('.milkdown-image-block');
  const before = await images.count();

  await dropFiles(page, editor, [png()]);

  await expect(images).toHaveCount(before + 1);
  await expect(page.getByText(UNSUPPORTED)).toHaveCount(0);
});

test('an image dropped on a drawing is placed on the canvas', async ({
  page
}) => {
  const title = `Drop canvas ${Date.now()}`;
  await clickFileTreeCreateAction(page, 'New drawing canvas');
  const draft = page.getByRole('textbox', { name: 'New drawing canvas' });
  await draft.fill(title);
  await draft.press('Enter');
  const canvas = page.locator('.freeform-canvas-host .excalidraw');
  await expect(canvas).toBeVisible();
  // Excalidraw selects an image as it inserts it, and offers "Crop image"
  // only while an image element is selected.
  const cropImage = canvas.getByRole('button', { name: 'Crop image' });
  await expect(cropImage).toHaveCount(0);

  await dropFiles(page, canvas, [png()]);

  await expect(cropImage).toBeVisible();
  await expect(page.getByText(UNSUPPORTED)).toHaveCount(0);
});

test('a PDF dropped outside any editor becomes a note at the root', async ({
  page
}) => {
  const name = `Root drop ${Date.now()}`;

  // The top bar: part of the window, but neither an editor nor the tree.
  await dropFiles(page, page.getByRole('banner'), [pdf(`${name}.pdf`)]);

  await expect(treeItem(page, name)).toBeVisible();
  // Root-level rows sit directly in the tree, not inside a folder's indent.
  await expect(
    fileTree(page).locator(':scope > [data-file-tree-node]', { hasText: name })
  ).toHaveCount(1);
});

test('a PDF dropped on a folder is imported into that folder', async ({
  page
}) => {
  const name = `Folder drop ${Date.now()}`;
  const folder = treeItem(page, 'Personal');

  await dropFiles(page, folder, [pdf(`${name}.pdf`)]);

  // The folder opens to show the new note among its children.
  const children = folder.locator('xpath=following-sibling::div[1]');
  await expect(
    children.getByRole('button', { name, exact: true })
  ).toBeVisible();
});

test('a PDF dropped on a markdown note is imported, not fed to the editor', async ({
  page
}) => {
  const name = `Editor drop ${Date.now()}`;
  const editor = await openWelcomeNote(page);
  const images = editor.locator('.milkdown-image-block');
  const before = await images.count();

  await dropFiles(page, editor, [pdf(`${name}.pdf`)]);

  await expect(treeItem(page, name)).toBeVisible();
  await expect(images).toHaveCount(before);
});

test('a drop nothing can use is reported instead of swallowed', async ({
  page
}) => {
  // The tree takes PDFs only, so an image has nowhere to go here.
  await dropFiles(page, treeItem(page, 'Personal'), [png()]);

  await expect(page.getByText(UNSUPPORTED)).toBeVisible();
  await expect(fileTree(page).getByText('photo')).toHaveCount(0);
});
