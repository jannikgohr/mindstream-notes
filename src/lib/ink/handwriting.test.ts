import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { InkDocument } from './document';
import { INK_DELETED_PAGES, INK_PAGES, INK_PAGE_ORDER } from './page-document';
import { extractInkBackgroundText, inkTextSignature } from './pdf-backgrounds';
import {
  INK_HANDWRITING,
  pagesToRecognize,
  recognizeInk,
  recognizedText
} from './handwriting';

const line = (y: number) => ({
  color: 0xff000000,
  width: 4,
  points: [
    { x: 100, y, pressure: 0.5 },
    { x: 300, y: y + 10, pressure: 0.5 }
  ]
});

describe('recognizeInk', () => {
  it('reads each written page once and again only after its strokes change', async () => {
    const ink = new InkDocument();
    ink.addStrokes([line(100)]);
    const recognize = vi.fn(async () => ' Einkaufsliste\n');
    const apply = vi.fn();
    const signal = new AbortController().signal;

    await recognizeInk(ink, recognize, apply, signal);
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(recognizedText(ink.doc)).toEqual(
      new Map([['legacy-page-0', 'Einkaufsliste']])
    );
    expect(apply).toHaveBeenCalledTimes(1);

    await recognizeInk(ink, recognize, apply, signal);
    expect(recognize).toHaveBeenCalledTimes(1);

    ink.addStrokes([line(200)]);
    expect(pagesToRecognize(ink).map((p) => p.page.id)).toEqual([
      'legacy-page-0'
    ]);

    ink.deleteStrokes(ink.visibleStrokes().map((s) => s.id));
    await recognizeInk(ink, recognize, apply, signal);
    expect(ink.doc.getMap(INK_HANDWRITING).size).toBe(0);
    expect(recognize).toHaveBeenCalledTimes(1);
    ink.doc.destroy();
  });

  it('drops a result that arrives after the editor closed', async () => {
    const ink = new InkDocument();
    ink.addStrokes([line(100)]);
    const controller = new AbortController();
    await recognizeInk(
      ink,
      async () => {
        controller.abort();
        return 'late';
      },
      () => {},
      controller.signal
    );
    expect(recognizedText(ink.doc).size).toBe(0);
    ink.doc.destroy();
  });
});

describe('search text', () => {
  it('signs recognized pages exactly as ink_background_signature does in Rust', () => {
    const doc = new Y.Doc();
    const pages = doc.getMap<unknown>(INK_PAGES);
    const order = doc.getMap<number>(INK_PAGE_ORDER);
    const deleted = doc.getMap<boolean>(INK_DELETED_PAGES);
    const size = { width: 100, height: 100 };
    pages.set('page_a', {
      id: 'page_a',
      ...size,
      background: {
        assetId: 'asset_image',
        textAssetId: 'asset_pdf',
        pageIndex: 2
      }
    });
    order.set('page_a', 1);
    pages.set('page_b', {
      id: 'page_b',
      ...size,
      background: { assetId: 'asset_removed', pageIndex: 0 }
    });
    order.set('page_b', 0.5);
    deleted.set('page_b', true);
    pages.set('page_c', { id: 'page_c', ...size });
    order.set('page_c', 2);
    pages.set('page_d', {
      id: 'page_d',
      ...size,
      background: { assetId: 'asset_late', pageIndex: 1 }
    });
    const handwriting = doc.getMap<unknown>(INK_HANDWRITING);
    handwriting.set('page_c', { text: 'Einkaufsliste', signature: 'c1' });
    handwriting.set('page_a', { text: 'Einkaufsliste', signature: 'a1' });
    handwriting.set('page_x', 'not an entry');
    const ink = new InkDocument(doc);
    // The Rust twin is ink_signature_skips_deleted_and_bare_pages_and_signs_text_assets.
    expect(inkTextSignature(ink)).toBe(
      '[["page_d","asset_late",1],["page_a","asset_pdf",2],["page_a","a1"],["page_c","c1"]]'
    );
    doc.destroy();
  });

  it('adds recognized handwriting to the page it was written on', async () => {
    const pages = [
      { id: 'one', width: 100, height: 100 },
      { id: 'two', width: 100, height: 100 }
    ];
    await expect(
      extractInkBackgroundText(
        pages,
        new Map([
          ['two', 'Milch'],
          ['one', 'Brot']
        ])
      )
    ).resolves.toBe('Brot\n\nMilch');
  });
});
