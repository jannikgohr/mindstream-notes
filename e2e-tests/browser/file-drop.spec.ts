import { deflateSync } from 'node:zlib';
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

const SVG_PICTURE =
  '<rect width="40" height="20" fill="#0c8599"/><circle cx="20" cy="10" r="6"/>';

const svgBytes = (extra = ''): number[] =>
  Array.from(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20">${extra}${SVG_PICTURE}</svg>`
    )
  );

/**
 * An SVG the way Excalidraw exports one with "Embed scene" on: the picture,
 * plus the scene that drew it, deflated into a metadata comment. Dropped on a
 * canvas as it is, Excalidraw loads that scene over whatever is open.
 */
function excalidrawExportSvg(): DroppedFile {
  const scene = {
    type: 'excalidraw',
    version: 2,
    source: 'https://excalidraw.com',
    elements: [
      {
        id: 'embedded-rect',
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 320,
        height: 160,
        angle: 0,
        strokeColor: '#e03131',
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: 1,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false
      }
    ],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {}
  };
  // excalidraw/data/encode.ts: the deflated JSON as a byte string, in a JSON
  // envelope, base64-encoded between the payload markers.
  const envelope = JSON.stringify({
    version: '1',
    encoding: 'bstring',
    compressed: true,
    encoded: deflateSync(Buffer.from(JSON.stringify(scene))).toString('latin1')
  });
  const payload = Buffer.from(envelope, 'latin1').toString('base64');
  return {
    name: 'sketch.excalidraw.svg',
    type: 'image/svg+xml',
    bytes: svgBytes(
      `<!-- svg-source:excalidraw --><metadata><!-- payload-type:application/vnd.excalidraw+json --><!-- payload-version:2 --><!-- payload-start -->${payload}<!-- payload-end --></metadata>`
    )
  };
}

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

async function openNewDrawing(
  page: Page
): Promise<{ canvas: Locator; cropImage: Locator }> {
  await clickFileTreeCreateAction(page, 'New drawing canvas');
  const draft = page.getByRole('textbox', { name: 'New drawing canvas' });
  await draft.fill(`Drop canvas ${Date.now()}`);
  await draft.press('Enter');
  const canvas = page.locator('.freeform-canvas-host .excalidraw');
  await expect(canvas).toBeVisible();
  // Excalidraw selects an image as it inserts it, and offers "Crop image"
  // only while an image element is selected.
  const cropImage = canvas.getByRole('button', { name: 'Crop image' });
  await expect(cropImage).toHaveCount(0);
  return { canvas, cropImage };
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

test('an image dropped beside the text of a note still lands in it', async ({
  page
}) => {
  const editor = await openWelcomeNote(page);
  const images = editor.locator('.milkdown-image-block');
  const before = await images.count();
  // The scrolling pane around the text column. A drop in its empty space has
  // the pane for a target, which ProseMirror never hears about.
  const pane = editor.locator('xpath=ancestor::*[@data-file-drop-accept][1]');

  await dropFiles(page, pane, [png()]);

  await expect(images).toHaveCount(before + 1);
  await expect(page.getByText(UNSUPPORTED)).toHaveCount(0);
});

test('an image dropped on a drawing is placed on the canvas', async ({
  page
}) => {
  const { canvas, cropImage } = await openNewDrawing(page);

  await dropFiles(page, canvas, [png()]);

  await expect(cropImage).toBeVisible();
  await expect(page.getByText(UNSUPPORTED)).toHaveCount(0);
});

test('a dropped Excalidraw export is placed as a picture, not loaded as a scene', async ({
  page
}) => {
  const { canvas, cropImage } = await openNewDrawing(page);

  await dropFiles(page, canvas, [excalidrawExportSvg()]);

  // Loading the embedded scene would swap the canvas for the export's own
  // shapes and leave no image selected.
  await expect(cropImage).toBeVisible();
});

test('an image the desktop gave no type is still placed on a drawing', async ({
  page
}) => {
  const { canvas, cropImage } = await openNewDrawing(page);

  // Excalidraw can't tell an SVG from its bytes, and says so in a dialog.
  await dropFiles(page, canvas, [
    { name: 'diagram.svg', type: '', bytes: svgBytes() }
  ]);

  await expect(cropImage).toBeVisible();
  await expect(page.getByText("Couldn't load invalid file")).toHaveCount(0);
});

test('a drawing takes the image from a drop that lists a PDF first', async ({
  page
}) => {
  const name = `Canvas mixed ${Date.now()}`;
  const { canvas, cropImage } = await openNewDrawing(page);

  await dropFiles(page, canvas, [pdf(`${name}.pdf`), png()]);

  await expect(cropImage).toBeVisible();
  // The PDF is imported behind the drawing. Opened in front it would hide the
  // canvas, and Excalidraw gives an image it sizes while hidden no size.
  await expect(treeItem(page, name)).toBeVisible();
  await expect(canvas).toBeVisible();
});

test('an image and a PDF dropped together on a note each find their place', async ({
  page
}) => {
  const name = `Note mixed ${Date.now()}`;
  const editor = await openWelcomeNote(page);
  const images = editor.locator('.milkdown-image-block');
  const before = await images.count();

  await dropFiles(page, editor, [png(), pdf(`${name}.pdf`)]);

  await expect(images).toHaveCount(before + 1);
  await expect(treeItem(page, name)).toBeVisible();
  // The note that took the image stays in front of the imported PDF.
  await expect(editor).toBeVisible();
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
