import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { statSync } from 'node:fs';
import { clickFileTreeCreateAction } from './file-tree-toolbar';

test.use({ hasTouch: true });

test('normal ink notes keep appending blank pages after using page management', async ({
  page
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Welcome', exact: true })
  ).toBeVisible();
  await clickFileTreeCreateAction(page, 'New handwritten note');
  await page
    .getByRole('textbox', { name: 'New handwritten note', exact: true })
    .press('Enter');
  const sorter = page.getByRole('button', { name: 'Pages', exact: true });
  await sorter.click();
  const manager = page.getByRole('region', { name: 'Pages', exact: true });
  await expect(manager.getByRole('listitem')).toHaveCount(2);
  await manager
    .getByRole('button', { name: 'Insert blank page', exact: true })
    .click();
  await expect(manager.getByRole('listitem')).toHaveCount(3);
  await manager
    .getByRole('button', { name: 'Go to page 3', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await draw(page, 'Handwritten note canvas');
  await sorter.click();
  await expect(manager.getByRole('listitem')).toHaveCount(4);
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', {
      name: 'Close Untitled handwritten note',
      exact: true
    })
    .click();
  await page
    .getByRole('group', { name: 'File tree' })
    .getByRole('button', { name: 'Untitled handwritten note', exact: true })
    .click();
  await sorter.click();
  await expect(manager.getByRole('listitem')).toHaveCount(4);
});

test('imports a large local PDF as compressed image pages', async ({
  page
}) => {
  const path = process.env.INK_PDF_BENCH_FILE;
  test.skip(!path, 'Set INK_PDF_BENCH_FILE to measure a local PDF.');
  test.setTimeout(180_000);
  await openPdf(page, await fixture());
  await page
    .getByRole('group', { name: 'File tree' })
    .getByRole('button', { name: 'Mixed pages', exact: true })
    .click({ button: 'right' });
  await page
    .getByRole('menuitem', { name: 'Convert to handwritten note', exact: true })
    .click();
  await expect(page.getByLabel('Handwritten note canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Pages', exact: true }).click();
  const manager = page.getByRole('region', { name: 'Pages', exact: true });
  await page.evaluate(() => {
    const stats: { bytes: number; width: number; height: number }[] = [];
    (window as unknown as { pageImageStats: typeof stats }).pageImageStats =
      stats;
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      original.call(
        this,
        (blob) => {
          if (blob && type === 'image/jpeg')
            stats.push({
              bytes: blob.size,
              width: this.width,
              height: this.height
            });
          callback(blob);
        },
        type,
        quality
      );
    };
  });
  const start = performance.now();
  await manager.getByLabel('Import PDF', { exact: true }).setInputFiles(path!);
  const range = manager.getByLabel('Source pages', { exact: true });
  await expect(range).toBeVisible();
  const prepared = performance.now();
  const count = Number((await range.inputValue()).split('-').at(-1));
  await manager
    .getByRole('button', { name: 'Insert selected pages', exact: true })
    .click();
  await expect(manager.getByRole('listitem')).toHaveCount(2 + count, {
    timeout: 120_000
  });
  const stats = await page.evaluate(
    () =>
      (
        window as unknown as {
          pageImageStats: { bytes: number; width: number; height: number }[];
        }
      ).pageImageStats
  );
  expect(stats).toHaveLength(count * 2);
  const imageBytes = stats
    .filter((s) => Math.max(s.width, s.height) > 256)
    .reduce((n, s) => n + s.bytes, 0);
  expect(imageBytes).toBeLessThan(statSync(path!).size);
  console.log(
    '[ink.perf]',
    JSON.stringify({
      sourceBytes: statSync(path!).size,
      pages: count,
      preparationMs: Math.round(prepared - start),
      importMs: Math.round(performance.now() - prepared),
      imageBytes,
      previewBytes: stats
        .filter((s) => Math.max(s.width, s.height) <= 256)
        .reduce((n, s) => n + s.bytes, 0)
    })
  );
});

async function fixture(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf
    .addPage([595, 842])
    .drawText('Portrait searchable kiwi', { x: 40, y: 700, font });
  pdf
    .addPage([842, 595])
    .drawText('Landscape searchable mango', { x: 40, y: 480, font });
  return Buffer.from(await pdf.save());
}

async function openPdf(page: Page, bytes: Buffer) {
  await page.goto('/');
  const tree = page.getByRole('group', { name: 'File tree' });
  await expect(
    tree.getByRole('button', { name: 'Welcome', exact: true })
  ).toBeVisible();
  const transfer = await page.evaluateHandle((bytes) => {
    const data = new DataTransfer();
    data.items.add(
      new File([new Uint8Array(bytes)], 'Mixed pages.pdf', {
        type: 'application/pdf'
      })
    );
    return data;
  }, Array.from(bytes));
  await page
    .getByRole('banner')
    .dispatchEvent('dragover', { dataTransfer: transfer });
  await page
    .getByRole('banner')
    .dispatchEvent('drop', { dataTransfer: transfer });
  await tree.getByRole('button', { name: 'Mixed pages', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Pen', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Handwriting', exact: true })
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: 'Convert to handwritten note',
      exact: true
    })
  ).toHaveCount(0);
}

async function draw(page: Page, label: string) {
  const canvas = page.getByLabel(label, { exact: true });
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 - 30, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + 150, { steps: 8 });
  await page.mouse.up();
  await expect(
    page.getByRole('button', { name: 'Undo', exact: true })
  ).toBeEnabled();
}

test('converts a PDF independently, preserves page dimensions, and imports selected pages', async ({
  page
}) => {
  const bytes = await fixture();
  await openPdf(page, bytes);
  await page
    .getByRole('group', { name: 'File tree' })
    .getByRole('button', { name: 'Mixed pages', exact: true })
    .click({ button: 'right' });
  await page
    .getByRole('menuitem', { name: 'Convert to handwritten note', exact: true })
    .click();
  await expect(page.getByLabel('Handwritten note canvas')).toBeVisible();
  await expect(
    page
      .getByRole('group', { name: 'File tree' })
      .getByRole('button', { name: 'Mixed pages', exact: true })
  ).toHaveCount(2);
  await draw(page, 'Handwritten note canvas');
  const sorter = page.getByRole('button', { name: 'Pages', exact: true });
  await expect(sorter.locator('svg')).toHaveCount(1);
  const sorterBox = (await sorter.boundingBox())!;
  const canvasBox = (await page
    .getByLabel('Handwritten note canvas')
    .boundingBox())!;
  expect(sorterBox.x + sorterBox.width).toBeGreaterThan(
    canvasBox.x + canvasBox.width - 64
  );
  await sorter.click();
  const manager = page.getByRole('region', { name: 'Pages', exact: true });
  const cards = manager.getByRole('listitem');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('595 × 842');
  await expect(cards.nth(1)).toContainText('842 × 595');
  const handle = manager.getByRole('button', {
    name: 'Reorder page 2',
    exact: true
  });
  const from = (await handle.boundingBox())!;
  const to = (await cards.nth(0).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 8
  });
  await page.mouse.up();
  await expect(cards.nth(0)).toContainText('842 × 595');
  await expect(cards.nth(1)).toContainText('595 × 842');
  // The same handle supports keyboard and real touch input.
  await manager
    .getByRole('button', { name: 'Reorder page 1', exact: true })
    .focus();
  await page.keyboard.press('ArrowDown');
  await expect(cards.nth(0)).toContainText('595 × 842');
  const touchFrom = (await manager
    .getByRole('button', { name: 'Reorder page 2', exact: true })
    .boundingBox())!;
  const touchTo = (await cards.nth(0).boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      {
        x: touchFrom.x + touchFrom.width / 2,
        y: touchFrom.y + touchFrom.height / 2
      }
    ]
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { x: touchTo.x + touchTo.width / 2, y: touchTo.y + touchTo.height / 2 }
    ]
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: []
  });
  await cdp.detach();
  await expect(cards.nth(0)).toContainText('842 × 595');
  await expect
    .poll(() =>
      cards
        .nth(0)
        .locator('canvas')
        .evaluate((canvas: HTMLCanvasElement) =>
          Boolean(
            canvas
              .getContext('2d')
              ?.getImageData(0, 0, canvas.width, canvas.height)
              .data.some((value, i) => i % 4 !== 3 && value < 100)
          )
        )
    )
    .toBe(true);
  await page.screenshot({ path: test.info().outputPath('page-sorter.png') });

  await manager
    .getByRole('button', { name: 'Insert blank page', exact: true })
    .click();
  await expect(cards).toHaveCount(3);
  await manager.getByLabel('Import PDF', { exact: true }).setInputFiles({
    name: 'Selected pages.pdf',
    mimeType: 'application/pdf',
    buffer: bytes
  });
  await manager.getByLabel('Source pages', { exact: true }).fill('2');
  await manager
    .getByRole('button', { name: 'Insert selected pages', exact: true })
    .click();
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(1)).toContainText('842 × 595');
  await manager
    .getByRole('button', { name: 'Page 1 options', exact: true })
    .click();
  await page
    .getByRole('menuitem', { name: 'Delete page', exact: true })
    .click();
  await expect(cards).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(manager).not.toBeVisible();
  await expect(sorter).toBeFocused();
  await page.getByRole('button', { name: 'Search notes', exact: true }).click();
  await page.getByPlaceholder('Search notes').fill('kiwi');
  await expect(
    page.getByRole('dialog').getByText('Mixed pages', { exact: true })
  ).toHaveCount(2);
});

test('ordinary PDF notes use the same handwriting editor and retain ink when returning to the reader', async ({
  page
}) => {
  await openPdf(page, await fixture());
  await page.getByRole('button', { name: 'Pen', exact: true }).click();
  await draw(page, 'Handwriting');
  await expect(
    page.getByRole('button', { name: 'Lasso select', exact: true })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Back to PDF', exact: true }).click();
  await expect(page.locator('[data-annotation-id^="shared:"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Pen', exact: true }).click();
  await expect(page.getByLabel('Handwriting', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to PDF', exact: true }).click();
  await expect(page.locator('[data-annotation-id^="shared:"]')).toHaveCount(1);
});

test('switching handwriting tools and restoring focus preserve the scrolled canvas', async ({
  page
}) => {
  await openPdf(page, await fixture());
  await page
    .getByRole('group', { name: 'File tree' })
    .getByRole('button', { name: 'Mixed pages', exact: true })
    .click({ button: 'right' });
  await page
    .getByRole('menuitem', { name: 'Convert to handwritten note', exact: true })
    .click();
  const canvas = page.getByLabel('Handwritten note canvas', { exact: true });
  await draw(page, 'Handwritten note canvas');
  const original = await canvas.elementHandle();
  const pixels = () =>
    canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  const top = await pixels();
  await canvas.hover();
  await page.mouse.wheel(0, 650);
  await page.mouse.move(0, 0);
  await expect.poll(pixels).not.toBe(top);
  const scrolled = await pixels();
  for (const tool of ['Eraser', 'Lasso select', 'Pen']) {
    const button = page.getByRole('button', { name: tool, exact: true });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(async () => {
      window.dispatchEvent(new Event('focus'));
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    expect(await original!.evaluate((element) => element.isConnected)).toBe(
      true
    );
    expect(await pixels()).toBe(scrolled);
  }
});
