/**
 * Tests for the print-ready exporter. Each case builds a source PDF with
 * pdf-lib, runs it through exportPrintReadyPdf, and inspects the result:
 * no annotation objects left, decoded page content carrying the drawing,
 * form fields gone, and the appended comments pages.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  degrees,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  StandardFonts,
  decodePDFRawStream
} from 'pdf-lib';
import { inflateSync } from 'node:zlib';
import {
  badgeCenter,
  exportPrintReadyPdf,
  type PrintReadyLabels
} from './export-print-ready-pdf';
import type { PdfAnnotation } from './types';

const LABELS: PrintReadyLabels = {
  commentsHeading: 'Comments',
  page: 'Page {page}',
  resolved: 'Resolved'
};

afterEach(() => vi.restoreAllMocks());

async function makeBlankPdfBytes(pageCount = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([612, 792]);
  return await doc.save();
}

function annotation(overrides: Partial<PdfAnnotation>): PdfAnnotation {
  return {
    id: crypto.randomUUID(),
    type: 'highlight',
    pageIndex: 0,
    rects: [{ x: 100, y: 100, width: 200, height: 20 }],
    color: '#facc15',
    opacity: 0.5,
    authorId: 'tester',
    createdAt: '2026-06-03T00:00:00.000Z',
    updatedAt: '2026-06-03T00:00:00.000Z',
    ...overrides
  };
}

/** Every content stream of the page, decoded and joined. */
function pageContent(doc: PDFDocument, pageIndex = 0): string {
  const contents = doc.getPage(pageIndex).node.Contents();
  const refs =
    contents instanceof PDFArray
      ? contents.asArray()
      : contents
        ? [contents]
        : [];
  return refs
    .map((ref) => {
      const stream = doc.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) return '';
      const filter = stream.dict.get(PDFName.of('Filter'));
      const bytes =
        filter === PDFName.of('FlateDecode')
          ? inflateSync(stream.contents)
          : Buffer.from(stream.contents);
      return bytes.toString('latin1');
    })
    .join('\n');
}

/** Text pdf-lib writes with a standard font: WinAnsi bytes as a hex string. */
function shown(text: string): string {
  const hex = [...text]
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return `<${hex}>`;
}

/** Closed paths in the content; pdf-lib draws each rectangle as one. */
function closedPaths(content: string): number {
  return content.match(/^h$/gm)?.length ?? 0;
}

function annotCount(doc: PDFDocument, pageIndex = 0): number {
  const annots = doc.getPage(pageIndex).node.Annots();
  return annots ? annots.size() : 0;
}

function xObjectNames(doc: PDFDocument, pageIndex = 0): string[] {
  const resources = doc.getPage(pageIndex).node.Resources();
  const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  return xObjects ? xObjects.keys().map((key) => key.decodeText()) : [];
}

describe('exportPrintReadyPdf', () => {
  it.each(['dropdown', 'text', 'list'])(
    'repairs a filled %s appearance whose font resources are missing',
    async (kind) => {
      const source = await PDFDocument.create();
      const page = source.addPage();
      const form = source.getForm();
      const field =
        kind === 'dropdown'
          ? form.createDropdown('City')
          : kind === 'list'
            ? form.createOptionList('City')
            : form.createTextField('City');
      if ('setOptions' in field) {
        field.setOptions(['London', 'Berlin']);
        field.select('Berlin');
      } else field.setText('Berlin');
      field.addToPage(page, { x: 50, y: 100, width: 150, height: 30 });
      // pdf.js can save a value and /Tf instructions without a font resource
      // when the source form has no default appearance or default resources.
      const appearance = source.context.flateStream(
        '/Tx BMC q BT /Helvetica 13.33 Tf 0 g 2 5 Td (Berlin) Tj ET Q EMC',
        {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 150, 30],
          Resources: {}
        }
      );
      field.acroField
        .getWidgets()[0]
        .setNormalAppearance(source.context.register(appearance));
      const { bytes, warnings } = await exportPrintReadyPdf(
        await source.save({ updateFieldAppearances: false }),
        [],
        LABELS
      );
      const doc = await PDFDocument.load(bytes);
      expect(warnings).toEqual([]);
      expect(doc.getForm().getFields()).toHaveLength(0);
      expect(annotCount(doc)).toBe(0);
      const resources = doc
        .getPage(0)
        .node.Resources()!
        .lookup(PDFName.of('XObject'), PDFDict);
      const painted = doc.context.lookup(resources.values()[0]);
      expect(painted).toBeInstanceOf(PDFRawStream);
      if (!(painted instanceof PDFRawStream))
        throw new Error('Missing appearance stream');
      const fonts = painted.dict
        .lookup(PDFName.of('Resources'), PDFDict)
        .lookup(PDFName.of('Font'), PDFDict);
      expect(fonts.keys().length).toBeGreaterThan(0);
      expect(
        Buffer.from(decodePDFRawStream(painted).decode()).toString()
      ).toContain(shown('Berlin'));
    }
  );

  it('preserves a complete appearance using a custom font', async () => {
    const source = await PDFDocument.create();
    const page = source.addPage();
    const field = source.getForm().createDropdown('City');
    field.setOptions(['Berlin']);
    field.select('Berlin');
    field.addToPage(page, {
      x: 50,
      y: 100,
      width: 150,
      height: 30,
      font: await source.embedFont(StandardFonts.Courier)
    });
    const sourceBytes = await source.save();
    const original = (await PDFDocument.load(sourceBytes))
      .getForm()
      .getDropdown('City')
      .acroField.getWidgets()[0]
      .AP()!
      .get(PDFName.of('N'));
    const { bytes, warnings } = await exportPrintReadyPdf(
      sourceBytes,
      [],
      LABELS
    );
    const doc = await PDFDocument.load(bytes);
    const resources = doc
      .getPage(0)
      .node.Resources()!
      .lookup(PDFName.of('XObject'), PDFDict);
    expect(resources.values()).toEqual([original]);
    expect(warnings).toEqual([]);
  });

  it('preserves a field value drawn as outlines without any fonts', async () => {
    const source = await PDFDocument.create();
    const page = source.addPage();
    const field = source.getForm().createTextField('Barcode');
    field.addToPage(page, { x: 50, y: 100, width: 150, height: 30 });
    field.setText('12345');
    const ref = source.context.register(
      source.context.flateStream('q 0 0 150 30 re f Q', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 150, 30],
        Resources: {}
      })
    );
    field.acroField.getWidgets()[0].setNormalAppearance(ref);
    const { bytes, warnings } = await exportPrintReadyPdf(
      await source.save({ updateFieldAppearances: false }),
      [],
      LABELS
    );
    const doc = await PDFDocument.load(bytes);
    const appearances = doc
      .getPage(0)
      .node.Resources()!
      .lookup(PDFName.of('XObject'), PDFDict);
    expect(appearances.values()).toEqual([ref]);
    expect(warnings).toEqual([]);
  });

  it.each([4, 0, 6])(
    'handles an unencodable field with missing fonts and print flags %s',
    async (flags) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const source = await PDFDocument.create();
      const page = source.addPage();
      const field = source.getForm().createTextField('City');
      field.addToPage(page, { x: 50, y: 100, width: 150, height: 30 });
      field.setText('日本');
      const widget = field.acroField.getWidgets()[0];
      widget.dict.set(PDFName.of('F'), PDFNumber.of(flags));
      widget.setNormalAppearance(
        source.context.register(
          source.context.flateStream(
            '/Tx BMC q BT /Helvetica 12 Tf (missing) Tj ET Q EMC',
            {
              Type: 'XObject',
              Subtype: 'Form',
              BBox: [0, 0, 150, 30],
              Resources: {}
            }
          )
        )
      );
      const { bytes, warnings } = await exportPrintReadyPdf(
        await source.save({ updateFieldAppearances: false }),
        [],
        LABELS
      );
      const doc = await PDFDocument.load(bytes);
      if (flags === 4) {
        expect(warnings).toEqual(['form-not-flattened']);
        expect(doc.getForm().getTextField('City').getText()).toBe('日本');
        expect(annotCount(doc)).toBe(1);
      } else {
        expect(warnings).toEqual([]);
        expect(annotCount(doc)).toBe(0);
      }
    }
  );
  it('preserves source link annotations while flattening form widgets', async () => {
    const source = await PDFDocument.create();
    const page = source.addPage();
    source
      .getForm()
      .createTextField('name')
      .addToPage(page, { x: 20, y: 30, width: 100, height: 20 });
    const link = source.context.register(
      source.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [20, 100, 120, 120],
        A: { S: 'URI', URI: PDFString.of('https://example.com') }
      })
    );
    page.node.addAnnot(link);
    const { bytes, warnings } = await exportPrintReadyPdf(
      await source.save(),
      [],
      LABELS
    );
    const doc = await PDFDocument.load(bytes);
    expect(warnings).toEqual([]);
    expect(annotCount(doc)).toBe(1);
    const retained = doc.context.lookup(
      doc.getPage(0).node.Annots()!.get(0),
      PDFDict
    );
    expect(retained.get(PDFName.of('Subtype'))).toBe(PDFName.of('Link'));
    expect(
      retained
        .lookup(PDFName.of('A'), PDFDict)
        .lookup(PDFName.of('URI'), PDFString)
        .decodeText()
    ).toBe('https://example.com');
    expect(doc.catalog.getAcroForm()).toBeUndefined();
  });

  it.each(['value', 'reference'])(
    'preserves forms with a malformed %s appearance and warns once',
    async (kind) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const source = await PDFDocument.create();
      const page = source.addPage();
      source.getForm();
      const invalid = PDFNumber.of(42);
      page.node.addAnnot(
        source.context.register(
          source.context.obj({
            Type: 'Annot',
            Subtype: 'Widget',
            F: 4,
            Rect: [20, 30, 120, 50],
            AP: {
              N: kind === 'value' ? invalid : source.context.register(invalid)
            }
          })
        )
      );
      const { bytes, warnings } = await exportPrintReadyPdf(
        await source.save(),
        [annotation({})],
        LABELS
      );
      const doc = await PDFDocument.load(bytes);
      expect(warnings).toEqual(['form-not-flattened']);
      expect(annotCount(doc)).toBe(1);
      expect(doc.catalog.getAcroForm()).toBeDefined();
      expect(closedPaths(pageContent(doc))).toBe(1);
    }
  );

  it.each(['missing', 'invalid', 'empty'])(
    'handles a widget with a %s bounding box',
    async (bbox) => {
      const source = await PDFDocument.create();
      const page = source.addPage();
      source.getForm();
      const stream = source.context.flateStream('0 0 1 1 re f', {
        Type: 'XObject',
        Subtype: 'Form',
        Resources: {},
        ...(bbox === 'missing'
          ? {}
          : { BBox: bbox === 'empty' ? [0, 0, 0, 0] : [0, 0, 'invalid', 40] })
      });
      const ref = source.context.register(stream);
      page.node.addAnnot(
        source.context.register(
          source.context.obj({
            Type: 'Annot',
            Subtype: 'Widget',
            F: 4,
            Rect: [200, 100, 50, 60],
            AP: { N: ref }
          })
        )
      );
      const { bytes, warnings } = await exportPrintReadyPdf(
        await source.save(),
        [],
        LABELS
      );
      const doc = await PDFDocument.load(bytes);
      expect(warnings).toEqual([]);
      expect(annotCount(doc)).toBe(0);
      expect(doc.catalog.getAcroForm()).toBeUndefined();
      if (bbox === 'empty') expect(xObjectNames(doc)).toHaveLength(0);
      else expect(pageContent(doc)).toContain('1 0 0 1 50 60 cm');
    }
  );

  it('skips an appearance state that is absent and drops hidden printable widgets', async () => {
    const source = await PDFDocument.create();
    const page = source.addPage();
    source.getForm();
    for (const flags of [4, 6]) {
      page.node.addAnnot(
        source.context.register(
          source.context.obj({
            Type: 'Annot',
            Subtype: 'Widget',
            F: flags,
            Rect: [20, 30, 120, 50],
            AP: { N: {} }
          })
        )
      );
    }
    const { bytes, warnings } = await exportPrintReadyPdf(
      await source.save(),
      [],
      LABELS
    );
    const doc = await PDFDocument.load(bytes);
    expect(warnings).toEqual([]);
    expect(annotCount(doc)).toBe(0);
    expect(xObjectNames(doc)).toHaveLength(0);
  });

  it('orders comments with the same height from left to right and starts new pages between entries', async () => {
    const annotations = Array.from({ length: 45 }, (_, index) =>
      annotation({
        type: 'comment',
        body: `Comment ${index}`,
        rects: [{ x: index * 2, y: 100, width: 1, height: 10 }]
      })
    ).reverse();
    const { bytes } = await exportPrintReadyPdf(
      await makeBlankPdfBytes(),
      annotations,
      LABELS
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(2);
    const first = pageContent(doc, 1);
    expect(first).toContain(shown('Comment 0'));
    expect(first).toContain(shown('Comment 1'));
    expect(first.indexOf(shown('Comment 0'))).toBeLessThan(
      first.indexOf(shown('Comment 1'))
    );
    expect(
      Array.from({ length: doc.getPageCount() - 1 }, (_, index) =>
        pageContent(doc, index + 1)
      ).join('\n')
    ).toContain(shown('Comment 44'));
  });

  it('ignores empty ink and signature data instead of creating broken XObjects', async () => {
    const { bytes, warnings } = await exportPrintReadyPdf(
      await makeBlankPdfBytes(),
      [
        annotation({ type: 'ink' }),
        annotation({ type: 'ink', strokes: [] }),
        annotation({
          type: 'ink',
          strokes: [
            { id: 'point', color: '', width: 1, points: [{ x: 10, y: 10 }] }
          ]
        }),
        annotation({ type: 'signature' }),
        annotation({
          type: 'signature',
          signature: { id: 'empty', width: 100, height: 50, strokes: [] }
        })
      ],
      LABELS
    );
    const doc = await PDFDocument.load(bytes);
    expect(warnings).toEqual([]);
    expect(xObjectNames(doc)).toHaveLength(0);
    expect(doc.getPageCount()).toBe(1);
  });
  it('draws highlights into the page with a multiply blend instead of adding annotations', async () => {
    const { bytes, warnings } = await exportPrintReadyPdf(
      await makeBlankPdfBytes(),
      [
        annotation({
          rects: [
            { x: 100, y: 100, width: 200, height: 20 },
            { x: 100, y: 80, width: 120, height: 20 }
          ]
        })
      ],
      LABELS
    );
    const doc = await PDFDocument.load(bytes);
    expect(warnings).toEqual([]);
    expect(annotCount(doc)).toBe(0);
    expect(closedPaths(pageContent(doc))).toBe(2);
    const graphics = doc
      .getPage(0)
      .node.Resources()!
      .lookup(PDFName.of('ExtGState'), PDFDict);
    const blendModes = graphics
      .values()
      .map((value) => doc.context.lookup(value, PDFDict))
      .map((state) => state.get(PDFName.of('BM')));
    expect(blendModes).toContain(PDFName.of('Multiply'));
  });

  it('numbers comments in reading order and lists them on an appended page', async () => {
    const { bytes } = await exportPrintReadyPdf(
      await makeBlankPdfBytes(2),
      [
        annotation({
          type: 'comment',
          pageIndex: 1,
          body: 'Second page note'
        }),
        annotation({
          type: 'comment',
          rects: [{ x: 50, y: 300, width: 100, height: 40 }],
          body: 'Lower on page one'
        }),
        annotation({
          type: 'highlight',
          rects: [{ x: 50, y: 700, width: 100, height: 12 }],
          body: 'Top of page one'
        })
      ],
      LABELS
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3);
    expect(annotCount(doc, 0)).toBe(0);
    expect(annotCount(doc, 1)).toBe(0);

    const firstPage = pageContent(doc, 0);
    expect(firstPage).toContain(shown('1'));
    expect(firstPage).toContain(shown('2'));
    expect(pageContent(doc, 1)).toContain(shown('3'));

    const list = pageContent(doc, 2);
    expect(list).toContain(shown('Comments'));
    const order = [
      'Top of page one',
      'Lower on page one',
      'Second page note'
    ].map((body) => list.indexOf(shown(body)));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(list).toContain(shown('Page 2'));
  });

  it('tags resolved comments and draws them dimmed', async () => {
    const { bytes } = await exportPrintReadyPdf(
      await makeBlankPdfBytes(),
      [annotation({ type: 'comment', body: 'Done', resolved: true })],
      LABELS
    );
    const doc = await PDFDocument.load(bytes);
    expect(pageContent(doc, 1)).toContain(shown('Page 1 · Resolved'));
    const graphics = doc
      .getPage(0)
      .node.Resources()!
      .lookup(PDFName.of('ExtGState'), PDFDict);
    const fillOpacities = graphics
      .values()
      .map((value) => doc.context.lookup(value, PDFDict).get(PDFName.of('ca')))
      .filter((value): value is PDFNumber => value instanceof PDFNumber)
      .map((value) => value.asNumber());
    expect(fillOpacities).toContain(0.5 * 0.36);
  });

  it('adds no comments page when no annotation has comment text', async () => {
    const { bytes } = await exportPrintReadyPdf(
      await makeBlankPdfBytes(),
      [
        annotation({ type: 'comment', body: '   ' }),
        annotation({ type: 'highlight' }),
        annotation({
          type: 'comment',
          body: 'deleted',
          deletedAt: '2026-06-04T00:00:00.000Z'
        }),
        annotation({ type: 'comment', body: 'off the end', pageIndex: 4 })
      ],
      LABELS
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    // The blank comment and the highlight are drawn; the rest are skipped.
    expect(closedPaths(pageContent(doc))).toBe(2);
  });

  it('paints ink and signatures as page XObjects', async () => {
    const stroke = {
      id: 's',
      color: '#ff0000',
      width: 2,
      points: [
        { x: 100, y: 100 },
        { x: 140, y: 120 },
        { x: 180, y: 100 }
      ]
    };
    const { bytes } = await exportPrintReadyPdf(
      await makeBlankPdfBytes(),
      [
        annotation({ id: 'shared:a', type: 'ink', strokes: [stroke] }),
        annotation({ type: 'ink', strokes: [stroke] }),
        annotation({
          type: 'signature',
          rects: [{ x: 300, y: 100, width: 120, height: 40 }],
          signature: {
            id: 'sig',
            width: 300,
            height: 100,
            strokes: [
              {
                id: 'sig-stroke',
                color: '#111111',
                width: 3,
                points: [
                  { x: 10, y: 50 },
                  { x: 150, y: 20 },
                  { x: 290, y: 60 }
                ]
              }
            ]
          }
        })
      ],
      LABELS
    );
    const doc = await PDFDocument.load(bytes);
    expect(annotCount(doc)).toBe(0);
    expect(
      xObjectNames(doc).filter((name) => name.startsWith('FlatAnnot'))
    ).toHaveLength(3);
    expect(pageContent(doc).match(/ Do\b/g)).toHaveLength(3);
  });

  it('flattens form fields and drops widgets that never print', async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([612, 792]);
    const form = source.getForm();
    const name = form.createTextField('name');
    name.setText('Ada Lovelace');
    name.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
    const button = form.createButton('print');
    button.addToPage('Print', page, { x: 50, y: 650, width: 80, height: 20 });
    button.acroField.getWidgets()[0].dict.set(PDFName.of('F'), PDFNumber.of(0));

    const { bytes, warnings } = await exportPrintReadyPdf(
      await source.save(),
      [],
      LABELS
    );
    const doc = await PDFDocument.load(bytes);
    expect(warnings).toEqual([]);
    expect(doc.getForm().getFields()).toHaveLength(0);
    expect(annotCount(doc)).toBe(0);
    expect(
      xObjectNames(doc).filter((key) => key.startsWith('FlatAnnot'))
    ).toHaveLength(1);
  });

  it('fits widget appearances onto their rect through /BBox and /Matrix', async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([612, 792]);
    const field = source.getForm().createTextField('name');
    field.addToPage(page, {
      x: 50,
      y: 60,
      width: 200,
      height: 100,
      borderWidth: 0
    });
    // A 10x20 box rotated a quarter turn becomes 20x10, so it has to be
    // scaled by 10 and shifted right by its new width to fill the rect.
    const appearance = source.context.formXObject([], {
      BBox: [0, 0, 10, 20],
      Matrix: [0, 1, -1, 0, 0, 0]
    });
    field.acroField
      .getWidgets()[0]
      .setNormalAppearance(source.context.register(appearance));

    const { bytes } = await exportPrintReadyPdf(
      await source.save({ updateFieldAppearances: false }),
      [],
      LABELS
    );
    const doc = await PDFDocument.load(bytes);
    expect(pageContent(doc)).toContain('10 0 0 10 250 60 cm');
  });

  it('draws the current state of a checkbox', async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([612, 792]);
    const box = source.getForm().createCheckBox('agree');
    box.addToPage(page, { x: 50, y: 700, width: 12, height: 12 });
    box.check();
    const sourceBytes = await source.save();

    const widget = (await PDFDocument.load(sourceBytes))
      .getForm()
      .getCheckBox('agree')
      .acroField.getWidgets()[0];
    const states = widget.AP()!.lookup(PDFName.of('N'), PDFDict);
    const checked = states.get(widget.getAppearanceState()!);

    const { bytes } = await exportPrintReadyPdf(sourceBytes, [], LABELS);
    const xObjects = (await PDFDocument.load(bytes))
      .getPage(0)
      .node.Resources()!
      .lookup(PDFName.of('XObject'), PDFDict);
    expect(xObjects.values()).toEqual([checked]);
  });

  it('keeps the form fillable and warns when a field has no usable appearance', async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([612, 792]);
    const field = source.getForm().createTextField('name');
    field.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
    // Helvetica can't encode this, so regenerating the missing appearance
    // fails, and without one there's nothing to draw.
    field.setText('日本');
    field.acroField.getWidgets()[0].dict.delete(PDFName.of('AP'));

    const { bytes, warnings } = await exportPrintReadyPdf(
      await source.save({ updateFieldAppearances: false }),
      [annotation({})],
      LABELS
    );
    const doc = await PDFDocument.load(bytes);
    expect(warnings).toEqual(['form-not-flattened']);
    expect(doc.getForm().getFields()).toHaveLength(1);
    // Annotations are still drawn on the reloaded document.
    expect(closedPaths(pageContent(doc))).toBe(1);
  });

  it('leaves XFA forms alone', async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([612, 792]);
    source
      .getForm()
      .createTextField('name')
      .addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
    // pdf-lib's own form handling drops XFA, so add it after a round trip.
    const withXfa = await PDFDocument.load(await source.save());
    withXfa.catalog
      .getAcroForm()!
      .dict.set(PDFName.of('XFA'), withXfa.context.obj([]));

    const { bytes, warnings } = await exportPrintReadyPdf(
      await withXfa.save(),
      [],
      LABELS
    );
    const doc = await PDFDocument.load(bytes);
    expect(warnings).toEqual(['form-not-flattened']);
    const acroForm = doc.catalog.getAcroForm()!;
    expect(acroForm.dict.has(PDFName.of('XFA'))).toBe(true);
    expect(acroForm.getAllFields()).toHaveLength(1);
  });

  it('replaces characters the built-in font cannot encode and says so', async () => {
    const { bytes, warnings } = await exportPrintReadyPdf(
      await makeBlankPdfBytes(),
      [annotation({ type: 'comment', body: 'Grüße 日本 Erdős' })],
      LABELS
    );
    const doc = await PDFDocument.load(bytes);
    expect(warnings).toEqual(['unsupported-characters']);
    expect(pageContent(doc, 1)).toContain(shown('Grüße ?? Erdos'));
  });

  it('wraps long comments onto further pages', async () => {
    const { bytes } = await exportPrintReadyPdf(
      await makeBlankPdfBytes(),
      [
        annotation({
          type: 'comment',
          body: `${'lorem ipsum '.repeat(1200)}${'x'.repeat(400)}`
        })
      ],
      LABELS
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(2);
    const lastPage = doc.getPage(doc.getPageCount() - 1);
    expect(lastPage.getWidth()).toBe(612);
  });

  it('matches comment pages to a sideways first page', async () => {
    const source = await PDFDocument.create();
    source.addPage([612, 792]).setRotation(degrees(90));
    const { bytes } = await exportPrintReadyPdf(
      await source.save(),
      [annotation({ type: 'comment', body: 'Landscape' })],
      LABELS
    );
    const doc = await PDFDocument.load(bytes);
    const list = doc.getPage(1);
    expect([list.getWidth(), list.getHeight()]).toEqual([792, 612]);
    expect(list.getRotation().angle).toBe(0);
  });

  it('returns the source unchanged in shape when there is nothing to draw', async () => {
    const { bytes, warnings } = await exportPrintReadyPdf(
      await makeBlankPdfBytes(2),
      [],
      LABELS
    );
    const doc = await PDFDocument.load(bytes);
    expect(warnings).toEqual([]);
    expect(doc.getPageCount()).toBe(2);
  });
});

describe('badgeCenter', () => {
  const rect = { x: 10, y: 20, width: 100, height: 50 };

  it('sits left of the first line as displayed after the page rotation', () => {
    expect(badgeCenter(rect, 0)).toEqual({ x: 2, y: 64 });
    expect(badgeCenter(rect, 90)).toEqual({ x: 16, y: 12 });
    expect(badgeCenter(rect, 180)).toEqual({ x: 118, y: 26 });
    expect(badgeCenter(rect, 270)).toEqual({ x: 104, y: 78 });
  });

  it('normalises negative and full-turn rotations', () => {
    expect(badgeCenter(rect, -90)).toEqual(badgeCenter(rect, 270));
    expect(badgeCenter(rect, 450)).toEqual(badgeCenter(rect, 90));
  });
});
