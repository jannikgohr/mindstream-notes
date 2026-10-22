import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { clickFileTreeCreateAction } from './file-tree-toolbar';

test.setTimeout(60000);

async function exportNote(page: Page, title: string, format: string) {
  await page
    .getByRole('button', { name: title, exact: true })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Export', exact: true }).hover();
  const pending = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: format, exact: true }).click();
  const download = await pending;
  const path = await download.path();
  expect(path).toBeTruthy();
  return { name: download.suggestedFilename(), bytes: await readFile(path!) };
}

async function createNote(page: Page, action: string, title: string) {
  await clickFileTreeCreateAction(page, action);
  const draft = page.getByRole('textbox', {
    name: action === 'New Kanban board' ? 'New note' : action,
    exact: true
  });
  await draft.fill(title);
  await draft.press('Enter');
  await expect(
    page.getByRole('button', { name: title, exact: true })
  ).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Welcome', exact: true })
  ).toBeVisible();
});

test('downloads standalone Markdown, HTML, a readable PDF and a Word document', async ({
  page
}) => {
  const mode = page.getByRole('button', { name: /^Editor view mode:/ });
  for (
    let index = 0;
    index < 4 &&
    (await mode.getAttribute('aria-label')) !== 'Editor view mode: Source';
    index++
  )
    await mode.click();
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 24;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'red';
    context.fillRect(0, 0, 32, 24);
    return canvas.toDataURL('image/png');
  });
  const source = page.locator('.cm-content');
  await source.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(
    `# Export check\n\nFresh **bold** text.\n\n![Red image](${image})\n\n| Name | Value |\n| --- | --- |\n| Test | 42 |\n`
  );
  const markdown = await exportNote(page, 'Welcome', 'Markdown');
  expect(markdown.name).toBe('Welcome.md');
  expect(markdown.bytes.toString()).toContain('title: Welcome');
  expect(markdown.bytes.toString()).toContain('Fresh **bold** text.');
  const html = await exportNote(page, 'Welcome', 'HTML');
  expect(html.bytes.toString()).toContain('<!doctype html>');
  const pdf = await exportNote(page, 'Welcome', 'PDF');
  expect((await PDFDocument.load(pdf.bytes)).getPageCount()).toBeGreaterThan(0);
  const word = await exportNote(page, 'Welcome', 'Word');
  const archive = unzipSync(word.bytes);
  expect(strFromU8(archive['word/document.xml'])).toContain('Welcome');
  expect(
    Object.keys(archive).some((path) => path.startsWith('word/media/'))
  ).toBe(true);
});

test('exports a Kanban board as CSV, Excel, Markdown and JSON', async ({
  page
}) => {
  await createNote(page, 'New Kanban board', 'Export board');
  const csv = await exportNote(page, 'Export board', 'CSV');
  expect(csv.bytes.toString()).toContain('"Column","Title","Description"');
  const excel = await exportNote(page, 'Export board', 'Excel');
  expect(strFromU8(unzipSync(excel.bytes)['xl/workbook.xml'])).toContain(
    'Cards'
  );
  const markdown = await exportNote(page, 'Export board', 'Markdown');
  expect(markdown.bytes.toString()).toContain('## To Do');
  const json = await exportNote(page, 'Export board', 'JSON');
  expect(JSON.parse(json.bytes.toString()).columns).toHaveLength(3);
});

test('exports a blank drawing to Excalidraw, PNG and SVG', async ({ page }) => {
  await createNote(page, 'New drawing canvas', 'Export drawing');
  const scene = await exportNote(page, 'Export drawing', 'Excalidraw');
  expect(JSON.parse(scene.bytes.toString()).type).toBe('excalidraw');
  await page.route('https://**', (route) => route.abort());
  const canvas = page.locator('.excalidraw canvas.interactive');
  await expect(canvas).toBeVisible();
  await canvas.click({ position: { x: 400, y: 350 } });
  await page.keyboard.press('t');
  await canvas.click({ position: { x: 400, y: 350 } });
  await page.keyboard.insertText('Offline export');
  await page.keyboard.press('Escape');
  const png = await exportNote(page, 'Export drawing', 'PNG');
  expect(png.bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const svg = await exportNote(page, 'Export drawing', 'SVG');
  expect(svg.bytes.toString()).toContain('<svg');
  expect(svg.bytes.toString()).toContain('Offline export');
  expect(svg.bytes.toString()).toContain('data:font/woff2');
});

test('exports a handwritten note to PNG', async ({ page }) => {
  await createNote(page, 'New handwritten note', 'Export handwriting');
  const png = await exportNote(page, 'Export handwriting', 'PNG pages');
  expect(png.bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
});

test('exports imported PDFs unchanged and lists annotations as Markdown', async ({
  page
}) => {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]).drawText('Original page');
  const bytes = await pdf.save();
  await page
    .locator('input[type="file"][accept="application/pdf,.pdf"]')
    .setInputFiles({
      name: 'Export original.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(bytes)
    });
  await expect(
    page.getByRole('button', { name: 'Export original', exact: true })
  ).toBeVisible();
  const original = await exportNote(page, 'Export original', 'Original PDF');
  expect(original.bytes).toEqual(Buffer.from(bytes));
  const markdown = await exportNote(
    page,
    'Export original',
    'Annotations as Markdown'
  );
  expect(markdown.bytes.toString()).toContain('No highlights or comments.');
});
