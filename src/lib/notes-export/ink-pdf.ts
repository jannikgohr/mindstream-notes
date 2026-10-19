/**
 * Render an ink note's `yrs_state` into a multi-page PDF — one PDF
 * page per ink page, strokes drawn as vector polylines with
 * pressure-modulated widths matching the on-screen renderer.
 *
 * Explicit pages retain source PDF dimensions, rotation and crop. Blank pages
 * convert ink units to PDF points at 2:1. Legacy inferred pages retain their
 * original export sizing for compatibility.
 *
 * Coordinates: ink space has Y growing downward; PDF user space has
 * Y growing upward. Per-stroke conversion is `pdfY = pageHeight - (y - pageTop)`.
 */

import { InkDocument } from '$lib/ink/document';
import type { InkStroke } from '$lib/ink/document';
import { defaultLayout, strideY } from '$lib/ink/page';
import type { DocumentLayout } from '$lib/ink/page';
import { fetchAssetBytes } from '$lib/api/assets';
import { pressureWidth } from '$lib/ink/editor-helpers';

const WIDTH_QUANTUM = 0.25;

export async function buildInkPdf(
  yrsState: number[] | Uint8Array
): Promise<Uint8Array | null> {
  const bytes =
    yrsState instanceof Uint8Array ? yrsState : new Uint8Array(yrsState);

  let inkDoc: InkDocument;
  try {
    inkDoc = InkDocument.fromBytes(bytes);
  } catch (err) {
    // A corrupt yrs_state shouldn't take the whole export down. Let
    // the caller log + skip; null signals "nothing usable" so an empty
    // doc (which still produces a valid blank PDF below) stays distinct.
    console.warn('[notes-export] could not decode yrs_state for ink note', err);
    return null;
  }

  const strokes = inkDoc.visibleStrokes();
  if (inkDoc.hasPages()) {
    try {
      return await buildPagedInkPdf(inkDoc);
    } finally {
      inkDoc.doc.destroy();
    }
  }
  // The editor keeps a trailing blank page (and a 2-page minimum) so
  // there's always room to keep drawing. The export wants the opposite
  // — just the pages that actually contain ink, with a single blank
  // page as a fallback so the file always exists.
  const baseLayout = defaultLayout();
  const maxY = inkDoc.contentMaxY();
  const exportPageCount =
    maxY > 0 ? Math.floor(maxY / strideY(baseLayout)) + 1 : 1;
  const layout: DocumentLayout = { ...baseLayout, pageCount: exportPageCount };

  const lib = await import('pdf-lib');
  const pdf = await lib.PDFDocument.create();

  for (let i = 0; i < layout.pageCount; i++) {
    const page = pdf.addPage([layout.page.width, layout.page.height]);
    drawPageStrokes(page, strokes, layout, i, lib);
  }

  return await pdf.save();
}

async function buildPagedInkPdf(ink: InkDocument): Promise<Uint8Array> {
  const lib = await import('pdf-lib');
  const pdf = await lib.PDFDocument.create();
  const sources = new Map<
    string,
    Awaited<ReturnType<typeof lib.PDFDocument.load>>
  >();
  for (const record of ink.pages()) {
    let page: import('pdf-lib').PDFPage;
    if (record.background?.kind === 'image') {
      page = pdf.addPage([record.width / 2, record.height / 2]);
      const image = await pdf.embedJpg(
        await fetchAssetBytes(record.background.assetId, 'image/jpeg')
      );
      page.drawImage(image, {
        x: 0,
        y: 0,
        width: record.width / 2,
        height: record.height / 2
      });
    } else if (record.background) {
      const { assetId, pageIndex } = record.background;
      let source = sources.get(assetId);
      if (!source) {
        source = await lib.PDFDocument.load(await fetchAssetBytes(assetId));
        sources.set(assetId, source);
      }
      const [copied] = await pdf.copyPages(source, [pageIndex]);
      page = pdf.addPage(copied);
    } else page = pdf.addPage([record.width / 2, record.height / 2]);
    const [a, b, c, d, e, f] = (record.background?.kind === 'image'
      ? undefined
      : record.pdfTransform) ?? [2, 0, 0, -2, 0, record.height];
    const det = a * d - b * c;
    const strokes = ink.pageStrokes(record.id).map((stroke) => ({
      ...stroke,
      width: stroke.width / 2,
      bounds: undefined,
      points: stroke.points.map((p) => ({
        ...p,
        x: (d * (p.x - e) - c * (p.y - f)) / det,
        y: page.getHeight() - (-b * (p.x - e) + a * (p.y - f)) / det
      }))
    }));
    drawPageStrokes(
      page,
      strokes,
      {
        page: { width: page.getWidth(), height: page.getHeight() },
        pageCount: 1,
        pageGap: 0
      },
      0,
      lib
    );
  }
  return pdf.save();
}

function drawPageStrokes(
  page: import('pdf-lib').PDFPage,
  strokes: InkStroke[],
  layout: DocumentLayout,
  pageIndex: number,
  lib: typeof import('pdf-lib')
): void {
  const pageTop = pageIndex * strideY(layout);
  const pageBottom = pageTop + layout.page.height;
  const ops: import('pdf-lib').PDFOperator[] = [];

  let activeColor: number | null = null;
  for (const stroke of strokes) {
    if (stroke.points.length < 2) continue;
    // Vertical-band cull. The page covers the full document width, so
    // there's no value culling horizontally.
    if (
      stroke.bounds &&
      (stroke.bounds.maxY < pageTop || stroke.bounds.minY > pageBottom)
    ) {
      continue;
    }
    if (activeColor !== stroke.color) {
      const [r, g, b] = argbToRgb01(stroke.color);
      ops.push(lib.setStrokingRgbColor(r, g, b));
      activeColor = stroke.color;
    }
    appendStrokeOps(ops, stroke, layout, pageTop, lib);
  }

  if (ops.length === 0) return;
  // Round caps + joins once per page — every stroke uses the same
  // style, so setting them up front beats per-stroke repeats.
  page.pushOperators(
    lib.setLineCap(lib.LineCapStyle.Round),
    lib.setLineJoin(lib.LineJoinStyle.Round),
    ...ops
  );
}

function appendStrokeOps(
  ops: import('pdf-lib').PDFOperator[],
  stroke: InkStroke,
  layout: DocumentLayout,
  pageTop: number,
  lib: typeof import('pdf-lib')
): void {
  const pageHeight = layout.page.height;
  const toPdfY = (y: number) => pageHeight - (y - pageTop);

  // Mirrors InkWebNoteEditor.drawStroke: pressure-modulated width is
  // averaged across each segment and quantized to 0.25 so consecutive
  // segments at the same width batch into a single moveTo/lineTo run.
  const points = stroke.points;
  let previous = points[0];
  let currentWidth = -1;
  let pathOpen = false;

  for (let i = 1; i < points.length; i++) {
    const curr = points[i];
    const pressure = (previous.pressure + curr.pressure) * 0.5;
    const raw = stroke.width * pressureWidth(pressure);
    const q = Math.max(
      WIDTH_QUANTUM,
      Math.round(raw / WIDTH_QUANTUM) * WIDTH_QUANTUM
    );

    if (!pathOpen || q !== currentWidth) {
      if (pathOpen) ops.push(lib.stroke());
      ops.push(lib.setLineWidth(q));
      ops.push(lib.moveTo(previous.x, toPdfY(previous.y)));
      currentWidth = q;
      pathOpen = true;
    }
    ops.push(lib.lineTo(curr.x, toPdfY(curr.y)));
    previous = curr;
  }

  if (pathOpen) ops.push(lib.stroke());
}

function argbToRgb01(argb: number): [number, number, number] {
  const r = ((argb >>> 16) & 0xff) / 255;
  const g = ((argb >>> 8) & 0xff) / 255;
  const b = (argb & 0xff) / 255;
  return [r, g, b];
}
