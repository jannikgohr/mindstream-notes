import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import { InkDocument } from '$lib/ink/document';
import { buildInkPdf } from './ink-pdf';

const { fetchAssetBytes } = vi.hoisted(() => ({
  fetchAssetBytes: vi.fn()
}));
vi.mock('$lib/api/assets', () => ({ fetchAssetBytes }));

describe('PDF-backed ink export', () => {
  it('exports a saved JPEG at the displayed page size without reopening its PDF or applying rotation twice', async () => {
    const jpeg = Uint8Array.from(
      atob(
        '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AD//Z'
      ),
      (c) => c.charCodeAt(0)
    );
    fetchAssetBytes.mockReset().mockResolvedValue(jpeg);
    const ink = new InkDocument();
    ink.restorePages([
      {
        id: 'rotated-image',
        width: 1684,
        height: 1190,
        pdfTransform: [0, 2, 2, 0, -40, -20],
        background: {
          kind: 'image',
          assetId: 'asset_jpeg',
          thumbnailAssetId: 'asset_preview',
          pageIndex: 5,
          pixelWidth: 2526,
          pixelHeight: 1785,
          text: 'source text'
        }
      }
    ]);
    ink.addStrokes([
      {
        color: 0xff000000,
        width: 4,
        points: [
          { x: 50, y: 60, pressure: 1 },
          { x: 80, y: 90, pressure: 0.5 }
        ]
      }
    ]);
    const result = await PDFDocument.load((await buildInkPdf(ink.encode()))!);
    expect(result.getPageCount()).toBe(1);
    expect(result.getPage(0).getSize()).toEqual({ width: 842, height: 595 });
    expect(result.getPage(0).getRotation().angle).toBe(0);
    expect(fetchAssetBytes).toHaveBeenCalledTimes(1);
    expect(fetchAssetBytes).toHaveBeenCalledWith('asset_jpeg', 'image/jpeg');
    ink.doc.destroy();
  });
  it('exports background-only pages, their original dimensions, rotation, crop, and explicit blanks in order', async () => {
    const source = await PDFDocument.create();
    source.addPage([595, 842]);
    const rotated = source.addPage([595, 842]);
    rotated.setRotation(degrees(90));
    rotated.setCropBox(10, 20, 560, 800);
    fetchAssetBytes.mockResolvedValue(await source.save());
    const ink = new InkDocument();
    ink.restorePages([
      {
        id: 'landscape',
        width: 1600,
        height: 1120,
        background: { assetId: 'asset_pdf', pageIndex: 1 },
        pdfTransform: [0, 2, 2, 0, -40, -20]
      },
      { id: 'blank', width: 1190, height: 1684 },
      {
        id: 'portrait',
        width: 1190,
        height: 1684,
        background: { assetId: 'asset_pdf', pageIndex: 0 }
      }
    ]);
    const result = await PDFDocument.load((await buildInkPdf(ink.encode()))!);
    expect(result.getPageCount()).toBe(3);
    expect(result.getPage(0).getRotation().angle).toBe(90);
    expect(result.getPage(0).getCropBox()).toEqual({
      x: 10,
      y: 20,
      width: 560,
      height: 800
    });
    expect(result.getPage(1).getSize()).toEqual({ width: 595, height: 842 });
    expect(result.getPage(2).getSize()).toEqual({ width: 595, height: 842 });
    expect(fetchAssetBytes).toHaveBeenCalledWith('asset_pdf');
    ink.doc.destroy();
  });
  it('keeps stroke geometry on the correct page after a page move and a save/reopen', async () => {
    const ink = new InkDocument();
    ink.restorePages([
      { id: 'a', width: 1190, height: 1684 },
      { id: 'b', width: 1684, height: 1190 }
    ]);
    ink.addStrokes([
      {
        color: 0xff112233,
        width: 4,
        points: [
          { x: 300, y: 40, pressure: 0.5 },
          { x: 350, y: 80, pressure: 0.8 }
        ]
      }
    ]);
    const points = ink.pageStrokes('a')[0].points;
    ink.movePage('a', 1);
    const reopened = InkDocument.fromBytes(ink.encode());
    expect(reopened.pageStrokes('a')[0].points).toEqual(points);
    const result = await PDFDocument.load(
      (await buildInkPdf(reopened.encode()))!
    );
    expect(result.getPages().map((page) => page.getSize())).toEqual([
      { width: 842, height: 595 },
      { width: 595, height: 842 }
    ]);
    ink.doc.destroy();
    reopened.doc.destroy();
  });
});
