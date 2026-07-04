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
 *                                       the placement rect, with a filled
 *                                       appearance stream for variable width)
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
import { strokeOutlinePath } from './stroke-utils';

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

function strokeBounds(
  points: { x: number; y: number }[],
  padding = 0
): PdfRect {
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
type PdfContext = Awaited<
  ReturnType<PdfLibModule['PDFDocument']['load']>
>['context'];

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
  const bbox = strokeBounds(
    allPoints,
    Math.max(...annotation.strokes.map((s) => s.width))
  );
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

function pdfNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3).replace(/\.?0+$/, '') : '0';
}

function signaturePointToAppearance(
  point: { x: number; y: number },
  signature: PdfSignatureSnapshot,
  placement: PdfRect
): { x: number; y: number } {
  const sx = placement.width / Math.max(1, signature.width);
  const sy = placement.height / Math.max(1, signature.height);
  return {
    x: point.x * sx,
    y: placement.height - point.y * sy
  };
}

function quadraticToCubic(
  start: { x: number; y: number },
  control: { x: number; y: number },
  end: { x: number; y: number }
): string {
  const c1 = {
    x: start.x + (2 / 3) * (control.x - start.x),
    y: start.y + (2 / 3) * (control.y - start.y)
  };
  const c2 = {
    x: end.x + (2 / 3) * (control.x - end.x),
    y: end.y + (2 / 3) * (control.y - end.y)
  };
  return `${pdfNumber(c1.x)} ${pdfNumber(c1.y)} ${pdfNumber(c2.x)} ${pdfNumber(c2.y)} ${pdfNumber(end.x)} ${pdfNumber(end.y)} c`;
}

function signatureStrokeAppearancePath(
  stroke: PdfInkStroke,
  signature: PdfSignatureSnapshot,
  placement: PdfRect
): string {
  const svgPath = strokeOutlinePath(stroke);
  const tokens = svgPath.match(/[A-Za-z]|-?\d+(?:\.\d+)?/g) ?? [];
  if (tokens.length < 6 || tokens[0] !== 'M') return '';

  let index = 1;
  const readPoint = () => {
    const x = Number(tokens[index++]);
    const y = Number(tokens[index++]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return signaturePointToAppearance({ x, y }, signature, placement);
  };

  let current = readPoint();
  if (!current || tokens[index++] !== 'Q') return '';
  const commands = [`${pdfNumber(current.x)} ${pdfNumber(current.y)} m`];

  while (index < tokens.length) {
    if (tokens[index] === 'Z') break;
    const control = readPoint();
    const end = readPoint();
    if (!control || !end) return '';
    commands.push(quadraticToCubic(current, control, end));
    current = end;
  }

  commands.push('f');
  return commands.join('\n');
}

function buildSignatureAppearanceRef(
  signature: PdfSignatureSnapshot,
  placement: PdfRect,
  opacity: number,
  context: PdfContext
): unknown | null {
  const commands: string[] = ['q', '/GS0 gs'];
  for (const stroke of signature.strokes) {
    const path = signatureStrokeAppearancePath(stroke, signature, placement);
    if (!path) continue;
    const [r, g, b] = hexToRgb(stroke.color);
    commands.push(`${pdfNumber(r)} ${pdfNumber(g)} ${pdfNumber(b)} rg`, path);
  }
  if (commands.length === 2) return null;
  commands.push('Q');

  const stream = context.flateStream(commands.join('\n'), {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, placement.width, placement.height],
    Resources: {
      ExtGState: {
        GS0: {
          ca: opacity,
          CA: opacity
        }
      }
    }
  });
  return context.register(stream);
}

function buildSignature(
  annotation: PdfAnnotation,
  lib: PdfLibModule,
  context: PdfContext
) {
  if (!annotation.signature) return null;
  const placement = unionRects(annotation.rects);
  const strokes = mapSignatureToPlacement(annotation.signature, placement);
  const inkList = inkListFromStrokes(strokes);
  if (inkList.length === 0) return null;
  const [r, g, b] = hexToRgb(strokes[0].color || annotation.color);
  const width = strokes[0]?.width ?? 1.5;
  const dict: Record<string, unknown> = {
    Type: 'Annot',
    Subtype: 'Ink',
    Rect: rectArray(placement),
    InkList: inkList,
    C: [r, g, b],
    CA: annotation.opacity,
    F: ANNOT_FLAG_PRINT,
    BS: { Type: 'Border', W: width },
    T: lib.PDFHexString.fromText(annotation.authorId),
    M: lib.PDFString.of(toPdfDate(annotation.updatedAt))
  };
  const appearanceRef = buildSignatureAppearanceRef(
    annotation.signature,
    placement,
    annotation.opacity,
    context
  );
  if (appearanceRef) dict.AP = { N: appearanceRef };
  if (annotation.body) {
    dict.Contents = lib.PDFHexString.fromText(annotation.body);
  }
  return dict;
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
  lib: PdfLibModule,
  context: PdfContext
): Record<string, unknown> | null {
  switch (annotation.type) {
    case 'highlight':
      return buildHighlight(annotation, lib);
    case 'comment':
      return buildComment(annotation, lib);
    case 'ink':
      return buildInk(annotation, lib);
    case 'signature':
      return buildSignature(annotation, lib, context);
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
    if (annotation.pageIndex < 0 || annotation.pageIndex >= pages.length)
      continue;
    const dict = buildAnnotationDict(annotation, lib, context);
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
