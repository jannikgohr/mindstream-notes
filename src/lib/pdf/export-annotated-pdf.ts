/**
 * Render a PDF note's local-first annotations into the PDF binary as
 * real PDF annotation objects, so external readers (Acrobat, Preview,
 * Foxit, etc.) see them as native highlights / ink / sticky notes
 * and the underlying text stays selectable.
 *
 * Mapping (lossy on purpose — we pick the closest standard PDF type):
 *   highlight  -> /Subtype /Highlight  (with optional /Contents body)
 *   comment    -> /Subtype /Square     (rect outline + /Contents body)
 *   ink        -> /Subtype /Ink        (PDF ink polylines)
 *   signature  -> /Subtype /Ink        (pad-local strokes mapped into
 *                                       the placement rect)
 *
 * Coordinates: our model already stores points in PDF user space
 * (origin bottom-left, Y up) — see PdfNoteViewer's use of
 * viewport.convertToPdfPoint. We pass them through unchanged.
 */

import type {
  PdfAnnotation,
  PdfInkStroke,
  PdfRect,
  PdfSignatureSnapshot
} from './types';

const ANNOT_FLAG_PRINT = 4;

function hexToRgb(hex: string): [number, number, number] {
  const v = hex.replace('#', '');
  if (v.length !== 6) return [0, 0, 0];
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return [0, 0, 0];
  return [r, g, b];
}

function rectArray(rect: PdfRect): [number, number, number, number] {
  return [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height];
}

function unionRects(rects: PdfRect[]): PdfRect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// PDF 1.7 §12.5.6.10: 8 numbers per quad. Acrobat reads them in
// top-left, top-right, bottom-left, bottom-right order; we match that.
function quadPointsForRect(rect: PdfRect): number[] {
  const x1 = rect.x;
  const x2 = rect.x + rect.width;
  const yBot = rect.y;
  const yTop = rect.y + rect.height;
  return [x1, yTop, x2, yTop, x1, yBot, x2, yBot];
}

function strokeBounds(points: { x: number; y: number }[], padding = 0): PdfRect {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2
  };
}

function inkListFromStrokes(strokes: PdfInkStroke[]): number[][] {
  return strokes
    .filter((s) => s.points.length >= 2)
    .map((s) => s.points.flatMap((p) => [p.x, p.y]));
}

/** Map a signature's pad-local stroke (top-down Y in 0..pad.height)
 *  into the annotation's placement rect (PDF user space, Y up). */
function mapSignatureToPlacement(
  signature: PdfSignatureSnapshot,
  placement: PdfRect
): PdfInkStroke[] {
  const sx = placement.width / Math.max(1, signature.width);
  const sy = placement.height / Math.max(1, signature.height);
  return signature.strokes.map((stroke) => ({
    id: stroke.id,
    color: stroke.color,
    // PDF /BS /W is in user-space units. The on-screen pad is small;
    // scale stroke width by the placement's Y scale so signatures
    // dropped at different sizes look proportional.
    width: Math.max(0.5, stroke.width * sy),
    points: stroke.points.map((point) => ({
      x: placement.x + point.x * sx,
      y: placement.y + placement.height - point.y * sy
    }))
  }));
}

function annotationIsLive(annotation: PdfAnnotation): boolean {
  return !annotation.deletedAt;
}

type PdfLibModule = typeof import('pdf-lib');

function buildHighlight(annotation: PdfAnnotation, lib: PdfLibModule) {
  const [r, g, b] = hexToRgb(annotation.color);
  const quadPoints = annotation.rects.flatMap(quadPointsForRect);
  const bbox = unionRects(annotation.rects);
  const dict: Record<string, unknown> = {
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: rectArray(bbox),
    QuadPoints: quadPoints,
    C: [r, g, b],
    CA: annotation.opacity,
    F: ANNOT_FLAG_PRINT,
    T: lib.PDFHexString.fromText(annotation.authorId),
    M: lib.PDFString.of(toPdfDate(annotation.updatedAt))
  };
  if (annotation.body) {
    dict.Contents = lib.PDFHexString.fromText(annotation.body);
  }
  return dict;
}

function buildComment(annotation: PdfAnnotation, lib: PdfLibModule) {
  const [r, g, b] = hexToRgb(annotation.color);
  const rect = unionRects(annotation.rects);
  return {
    Type: 'Annot',
    Subtype: 'Square',
    Rect: rectArray(rect),
    C: [r, g, b],
    CA: annotation.opacity,
    F: ANNOT_FLAG_PRINT,
    BS: { Type: 'Border', W: 1.5 },
    T: lib.PDFHexString.fromText(annotation.authorId),
    M: lib.PDFString.of(toPdfDate(annotation.updatedAt)),
    Contents: lib.PDFHexString.fromText(annotation.body ?? '')
  };
}

function buildInk(annotation: PdfAnnotation, lib: PdfLibModule) {
  if (!annotation.strokes || annotation.strokes.length === 0) return null;
  const inkList = inkListFromStrokes(annotation.strokes);
  if (inkList.length === 0) return null;
  const allPoints = annotation.strokes.flatMap((s) => s.points);
  const bbox = strokeBounds(allPoints, Math.max(...annotation.strokes.map((s) => s.width)));
  const [r, g, b] = hexToRgb(annotation.strokes[0].color || annotation.color);
  const width = annotation.strokes[0]?.width ?? 1.5;
  const dict: Record<string, unknown> = {
    Type: 'Annot',
    Subtype: 'Ink',
    Rect: rectArray(bbox),
    InkList: inkList,
    C: [r, g, b],
    CA: annotation.opacity,
    F: ANNOT_FLAG_PRINT,
    BS: { Type: 'Border', W: width },
    T: lib.PDFHexString.fromText(annotation.authorId),
    M: lib.PDFString.of(toPdfDate(annotation.updatedAt))
  };
  if (annotation.body) {
    dict.Contents = lib.PDFHexString.fromText(annotation.body);
  }
  return dict;
}

function buildSignature(annotation: PdfAnnotation, lib: PdfLibModule) {
  if (!annotation.signature) return null;
  const placement = unionRects(annotation.rects);
  const strokes = mapSignatureToPlacement(annotation.signature, placement);
  return buildInk(
    {
      ...annotation,
      // The signature's authoritative ink lives under .signature; pretend
      // it's a regular ink annotation for the dict builder.
      strokes,
      // Keep the placement rect, not the source pad rect.
      rects: [placement]
    },
    lib
  );
}

function toPdfDate(iso: string): string {
  // PDF date string: D:YYYYMMDDHHmmSSZ
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return `D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
  }
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function buildAnnotationDict(
  annotation: PdfAnnotation,
  lib: PdfLibModule
): Record<string, unknown> | null {
  switch (annotation.type) {
    case 'highlight':
      return buildHighlight(annotation, lib);
    case 'comment':
      return buildComment(annotation, lib);
    case 'ink':
      return buildInk(annotation, lib);
    case 'signature':
      return buildSignature(annotation, lib);
    default:
      return null;
  }
}

/**
 * Build an annotated copy of the source PDF. Pure: takes bytes in, gets
 * bytes out, never touches the DOM or Yjs. The component layer is
 * responsible for fetching the source bytes and triggering the download.
 */
export async function exportAnnotatedPdf(
  sourceBytes: Uint8Array,
  annotations: PdfAnnotation[]
): Promise<Uint8Array> {
  const lib = await import('pdf-lib');
  const out = await lib.PDFDocument.load(sourceBytes, {
    // Trust the source: it's bytes we already opened with pdf.js in
    // the same session. Allowing updates is the default; we just don't
    // want pdf-lib failing on quirky-but-readable PDFs.
    updateMetadata: false,
    ignoreEncryption: false
  });
  const context = out.context;
  const pages = out.getPages();
  const annotsKey = lib.PDFName.of('Annots');

  for (const annotation of annotations) {
    if (!annotationIsLive(annotation)) continue;
    if (annotation.pageIndex < 0 || annotation.pageIndex >= pages.length) continue;
    const dict = buildAnnotationDict(annotation, lib);
    if (!dict) continue;
    // pdf-lib types `obj` as accepting a recursive Literal shape, which
    // isn't an exported type — Record<string, unknown> is structurally
    // identical but TS can't prove it. Cast at the boundary instead of
    // polluting each builder's return type with internal pdf-lib types.
    const annotObj = context.obj(dict as Parameters<typeof context.obj>[0]);
    const ref = context.register(annotObj);
    const page = pages[annotation.pageIndex];
    const existing = page.node.get(annotsKey);
    if (existing instanceof lib.PDFArray) {
      existing.push(ref);
    } else {
      page.node.set(annotsKey, context.obj([ref]));
    }
  }

  return await out.save();
}
