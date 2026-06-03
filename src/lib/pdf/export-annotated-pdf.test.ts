/**
 * Round-trip tests for the annotated-PDF exporter. We build a blank
 * source PDF with pdf-lib, run it through exportAnnotatedPdf with each
 * annotation type, then re-open the result with pdf-lib and inspect
 * the page's /Annots dictionary to verify the right entries landed.
 *
 * The point isn't pixel-rendering fidelity (that's pdf-lib's job) —
 * it's that our shape mapping doesn't silently drop fields or write
 * malformed dictionaries that crash external readers.
 */

import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { exportAnnotatedPdf } from './export-annotated-pdf';
import type { PdfAnnotation } from './types';

async function makeBlankPdfBytes(pageCount = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    doc.addPage([612, 792]); // US Letter, the default
  }
  return await doc.save();
}

function annotation(overrides: Partial<PdfAnnotation>): PdfAnnotation {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    type: overrides.type ?? 'highlight',
    pageIndex: overrides.pageIndex ?? 0,
    rects: overrides.rects ?? [{ x: 100, y: 100, width: 200, height: 20 }],
    color: overrides.color ?? '#facc15',
    opacity: overrides.opacity ?? 0.5,
    authorId: overrides.authorId ?? 'tester',
    createdAt: overrides.createdAt ?? '2026-06-03T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-06-03T00:00:00.000Z',
    body: overrides.body,
    resolved: overrides.resolved,
    deletedAt: overrides.deletedAt,
    strokes: overrides.strokes,
    signature: overrides.signature
  };
}

async function readPageAnnots(bytes: Uint8Array, pageIndex = 0) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(pageIndex);
  const raw = page.node.get(PDFName.of('Annots'));
  if (!(raw instanceof PDFArray)) return [];
  return raw.asArray().map((ref) => {
    const obj = doc.context.lookup(ref);
    if (!(obj instanceof PDFDict)) throw new Error('annot is not a dict');
    return obj;
  });
}

describe('exportAnnotatedPdf', () => {
  it('returns a parseable PDF when no annotations are present', async () => {
    const source = await makeBlankPdfBytes();
    const out = await exportAnnotatedPdf(source, []);
    const reopened = await PDFDocument.load(out);
    expect(reopened.getPageCount()).toBe(1);
  });

  it('writes a /Highlight annotation with QuadPoints and Contents', async () => {
    const source = await makeBlankPdfBytes();
    const out = await exportAnnotatedPdf(source, [
      annotation({
        type: 'highlight',
        rects: [{ x: 50, y: 700, width: 200, height: 14 }],
        body: 'note on this passage'
      })
    ]);
    const annots = await readPageAnnots(out);
    expect(annots).toHaveLength(1);
    const dict = annots[0];
    expect(dict.get(PDFName.of('Subtype'))).toEqual(PDFName.of('Highlight'));
    const quad = dict.get(PDFName.of('QuadPoints'));
    expect(quad).toBeInstanceOf(PDFArray);
    // 8 numbers per quad × 1 rect = 8 entries
    expect((quad as PDFArray).size()).toBe(8);
    const contents = dict.get(PDFName.of('Contents'));
    expect(contents).toBeDefined();
  });

  it('writes a /Square annotation for comments', async () => {
    const source = await makeBlankPdfBytes();
    const out = await exportAnnotatedPdf(source, [
      annotation({ type: 'comment', body: 'is this right?' })
    ]);
    const annots = await readPageAnnots(out);
    expect(annots).toHaveLength(1);
    expect(annots[0].get(PDFName.of('Subtype'))).toEqual(PDFName.of('Square'));
  });

  it('writes an /Ink annotation with an InkList for pen strokes', async () => {
    const source = await makeBlankPdfBytes();
    const out = await exportAnnotatedPdf(source, [
      annotation({
        type: 'ink',
        rects: [{ x: 100, y: 100, width: 200, height: 50 }],
        strokes: [
          {
            id: 's1',
            color: '#111827',
            width: 2,
            points: [
              { x: 100, y: 100 },
              { x: 150, y: 130 },
              { x: 200, y: 110 }
            ]
          }
        ]
      })
    ]);
    const annots = await readPageAnnots(out);
    expect(annots).toHaveLength(1);
    const dict = annots[0];
    expect(dict.get(PDFName.of('Subtype'))).toEqual(PDFName.of('Ink'));
    const inkList = dict.get(PDFName.of('InkList'));
    expect(inkList).toBeInstanceOf(PDFArray);
    expect((inkList as PDFArray).size()).toBe(1); // one stroke
    const stroke = (inkList as PDFArray).asArray()[0];
    expect(stroke).toBeInstanceOf(PDFArray);
    expect((stroke as PDFArray).size()).toBe(6); // 3 points × (x,y)
  });

  it('writes an /Ink annotation for signatures, mapping pad coords to placement', async () => {
    const source = await makeBlankPdfBytes();
    const out = await exportAnnotatedPdf(source, [
      annotation({
        type: 'signature',
        rects: [{ x: 100, y: 100, width: 180, height: 60 }],
        signature: {
          id: 'sig-1',
          width: 420,
          height: 168,
          strokes: [
            {
              id: 'pad-s1',
              color: '#111827',
              width: 3,
              points: [
                { x: 0, y: 0 }, // top-left of pad
                { x: 420, y: 168 } // bottom-right of pad
              ]
            }
          ]
        }
      })
    ]);
    const annots = await readPageAnnots(out);
    expect(annots).toHaveLength(1);
    const dict = annots[0];
    expect(dict.get(PDFName.of('Subtype'))).toEqual(PDFName.of('Ink'));
    const inkList = dict.get(PDFName.of('InkList')) as PDFArray;
    const stroke = inkList.asArray()[0] as PDFArray;
    const nums = stroke.asArray().map((n) => Number(n.toString()));
    // pad (0, 0) -> top-left of placement, which in PDF coords is
    // (rect.x, rect.y + rect.height) = (100, 160)
    expect(nums[0]).toBeCloseTo(100);
    expect(nums[1]).toBeCloseTo(160);
    // pad (420, 168) -> bottom-right -> (rect.x + rect.width, rect.y) = (280, 100)
    expect(nums[2]).toBeCloseTo(280);
    expect(nums[3]).toBeCloseTo(100);
  });

  it('skips annotations that fall outside the page range', async () => {
    const source = await makeBlankPdfBytes(2);
    const out = await exportAnnotatedPdf(source, [
      annotation({ pageIndex: 5, body: 'orphan' }),
      annotation({ pageIndex: -1, body: 'negative' }),
      annotation({ pageIndex: 1, body: 'real' })
    ]);
    expect(await readPageAnnots(out, 0)).toHaveLength(0);
    expect(await readPageAnnots(out, 1)).toHaveLength(1);
  });

  it('skips annotations with deletedAt set', async () => {
    const source = await makeBlankPdfBytes();
    const out = await exportAnnotatedPdf(source, [
      annotation({ body: 'kept' }),
      annotation({ body: 'tombstoned', deletedAt: '2026-06-03T00:00:01.000Z' })
    ]);
    expect(await readPageAnnots(out)).toHaveLength(1);
  });

  it('appends to an existing /Annots array instead of replacing it', async () => {
    // Pre-seed the source PDF with one annotation so we can verify our
    // exporter preserves it. Without the append branch we'd silently
    // wipe whatever the source PDF already had on the page.
    const seed = await PDFDocument.create();
    const page = seed.addPage([612, 792]);
    const pre = seed.context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [10, 10, 30, 30],
      Contents: PDFString.of('pre-existing')
    });
    const preRef = seed.context.register(pre);
    page.node.set(PDFName.of('Annots'), seed.context.obj([preRef]));
    const source = await seed.save();

    const out = await exportAnnotatedPdf(source, [annotation({ body: 'new' })]);
    expect(await readPageAnnots(out)).toHaveLength(2);
  });
});
