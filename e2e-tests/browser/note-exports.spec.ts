import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  decodePDFRawStream
} from 'pdf-lib';
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

test('prints a selected city from a form without default font resources', async ({
  page
}) => {
  const source = await PDFDocument.create();
  const pdfPage = source.addPage([400, 400]);
  pdfPage.drawText('City:', { x: 40, y: 250, size: 12 });
  const city = source.getForm().createDropdown('City');
  city.setOptions(['New York', 'London', 'Berlin', 'Paris', 'Rome']);
  city.enableEditing();
  city.addToPage(pdfPage, { x: 100, y: 240, width: 150, height: 25 });
  // Older forms may supply neither /DA nor /DR. pdf.js can display their
  // fields with a fallback font but save an appearance without that font.
  const unstyled = await PDFDocument.load(await source.save());
  const field = unstyled.getForm().getDropdown('City');
  field.acroField.dict.delete(PDFName.of('DA'));
  const widget = field.acroField.getWidgets()[0];
  widget.dict.delete(PDFName.of('DA'));
  widget.setNormalAppearance(
    unstyled.context.register(
      unstyled.context.flateStream('/Tx BMC q Q EMC', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 150, 25],
        Resources: {}
      })
    )
  );
  unstyled.catalog.getAcroForm()!.dict.delete(PDFName.of('DA'));
  unstyled.catalog.getAcroForm()!.dict.delete(PDFName.of('DR'));
  const bytes = await unstyled.save({ updateFieldAppearances: false });
  await page
    .locator('input[type="file"][accept="application/pdf,.pdf"]')
    .setInputFiles({
      name: 'City form.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(bytes)
    });
  const select = page.locator('select[name="City"]');
  await expect(select).toBeVisible();
  await select.selectOption({ label: 'Berlin' });
  const printed = await exportNote(page, 'City form', 'Print-ready PDF');
  const pdf = await PDFDocument.load(printed.bytes);
  expect(pdf.catalog.getAcroForm()).toBeUndefined();
  const appearances = pdf
    .getPage(0)
    .node.Resources()!
    .lookup(PDFName.of('XObject'), PDFDict);
  const cityAppearance = appearances
    .values()
    .map((ref) => pdf.context.lookup(ref))
    .filter((stream): stream is PDFRawStream => stream instanceof PDFRawStream)
    .find((stream) =>
      Buffer.from(decodePDFRawStream(stream).decode())
        .toString()
        .includes('<4265726C696E>')
    );
  expect(cityAppearance).toBeDefined();
  const fonts = cityAppearance!.dict
    .lookup(PDFName.of('Resources'), PDFDict)
    .lookup(PDFName.of('Font'), PDFDict);
  expect(fonts.keys().length).toBeGreaterThan(0);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: new Uint8Array(printed.bytes),
    standardFontDataUrl: fileURLToPath(
      new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
    )
  });
  try {
    const text = await (await (await task.promise).getPage(1)).getTextContent();
    expect(
      text.items.map((item) => ('str' in item ? item.str : '')).join(' ')
    ).toContain('Berlin');
  } finally {
    await task.destroy();
  }
});
