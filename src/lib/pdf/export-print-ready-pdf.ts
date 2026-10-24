/**
 * Build a print-ready copy of a PDF note. Where the annotated export adds
 * real annotation objects so other readers can still edit them, this one
 * draws every annotation straight into the page content:
 *
 *   highlight  -> filled rects, multiply blend so the text stays dark
 *   comment    -> outlined rect plus a numbered badge; the bodies are
 *                 listed on "Comments" pages appended to the document
 *   ink        -> the same strokes as a page-content Form XObject
 *   signature  -> the same image / outline paths, also painted directly
 *
 * Form fields are flattened too. Printers that render PDFs themselves
 * often skip annotations without an appearance stream (our highlights and
 * comment boxes have none) and never print popup text, so this export
 * leaves nothing for them to drop.
 *
 * Comment text uses the built-in Helvetica, which only covers WinAnsi.
 * Characters outside it are reduced to their base letter where possible
 * and otherwise replaced with "?", and the result reports that it did so.
 */

import type {
  PDFFont,
  PDFField,
  PDFObject,
  PDFPage,
  PDFRef,
  PDFWidgetAnnotation
} from 'pdf-lib';
import {
  buildSharedInkAppearanceRef,
  buildSignatureAppearanceRef,
  hexToRgb,
  inkBounds,
  pdfNumber,
  unionRects,
  type PdfContext,
  type PdfDocument,
  type PdfLibModule
} from './export-annotated-pdf';
import type { PdfAnnotation, PdfInkStroke, PdfRect } from './types';
import { isCommentLikeAnnotation } from './viewer-helpers';

export interface PrintReadyLabels {
  /** Heading of the appended comments pages. */
  commentsHeading: string;
  /** Per-comment page reference; `{page}` becomes the 1-based number. */
  page: string;
  /** Tag for resolved comments. */
  resolved: string;
}

export type PrintReadyWarning =
  /** The form couldn't be flattened, so its fields stay interactive. */
  | 'form-not-flattened'
  /** Some comment characters aren't in WinAnsi and were replaced. */
  | 'unsupported-characters';

export interface PrintReadyResult {
  bytes: Uint8Array;
  warnings: PrintReadyWarning[];
}

const ANNOT_FLAG_HIDDEN = 2;
const ANNOT_FLAG_PRINT = 4;

/** Matches `.pdf-app-annotation-resolved` in the viewer. */
const RESOLVED_OPACITY = 0.36;
const COMMENT_BORDER_WIDTH = 1.5;
const BADGE_RADIUS = 6;
/** Space between a badge and the left edge of its comment. */
const BADGE_GAP = 2;
const BADGE_FONT_SIZE = 7;
const BADGE_INK = [0.12, 0.12, 0.12] as const;

const PAGE_MARGIN = 56;
const HEADING_SIZE = 16;
const ENTRY_TITLE_SIZE = 10;
const BODY_SIZE = 10;
const LINE_HEIGHT = 13;
const ENTRY_INDENT = 22;
const ENTRY_GAP = 10;

interface NumberedComment {
  number: number;
  annotation: PdfAnnotation;
  body: string;
}

/**
 * Centre of a comment's badge: just outside the rect's left edge and level
 * with its first line, so it doesn't cover the marked text. "Left" and
 * "top" are as displayed after the page's /Rotate, which matters for scans
 * stored sideways.
 */
export function badgeCenter(
  rect: PdfRect,
  rotation: number
): { x: number; y: number } {
  const left = rect.x;
  const right = rect.x + rect.width;
  const bottom = rect.y;
  const top = rect.y + rect.height;
  const outward = BADGE_RADIUS + BADGE_GAP;
  switch (normalizeRotation(rotation)) {
    case 90:
      return { x: left + BADGE_RADIUS, y: bottom - outward };
    case 180:
      return { x: right + outward, y: bottom + BADGE_RADIUS };
    case 270:
      return { x: right - BADGE_RADIUS, y: top + outward };
    default:
      return { x: left - outward, y: top - BADGE_RADIUS };
  }
}

function normalizeRotation(rotation: number): number {
  return (((Math.round(rotation / 90) * 90) % 360) + 360) % 360;
}

/**
 * Comment-like annotations with text, numbered in reading order: by page,
 * then top to bottom, then left to right.
 */
function numberComments(annotations: PdfAnnotation[]): NumberedComment[] {
  return annotations
    .filter(
      (annotation) =>
        isCommentLikeAnnotation(annotation) &&
        annotation.rects.length > 0 &&
        (annotation.body ?? '').trim() !== ''
    )
    .map((annotation) => ({ annotation, box: unionRects(annotation.rects) }))
    .sort(
      (a, b) =>
        a.annotation.pageIndex - b.annotation.pageIndex ||
        b.box.y + b.box.height - (a.box.y + a.box.height) ||
        a.box.x - b.box.x
    )
    .map(({ annotation }, index) => ({
      number: index + 1,
      annotation,
      body: (annotation.body ?? '').trim()
    }));
}

/** Normal appearance for the widget's current state; `null` if it has none. */
function widgetAppearance(
  widget: PDFWidgetAnnotation,
  lib: PdfLibModule
): PDFRef | null {
  const normal = widget.AP()?.get(lib.PDFName.of('N'));
  if (!normal) throw new Error('Form widget has no appearance.');
  if (normal instanceof lib.PDFRef) return normal;
  if (normal instanceof lib.PDFDict) {
    // Checkboxes and radios: /AS picks the state. A state without an
    // appearance shows nothing in a viewer either.
    const state = widget.getAppearanceState();
    const ref = state ? normal.get(state) : undefined;
    if (ref === undefined) return null;
    if (ref instanceof lib.PDFRef) return ref;
  }
  throw new Error('Form widget appearance is not a stream.');
}

function widgetRect(widget: PDFWidgetAnnotation): PdfRect {
  const { x, y, width, height } = widget.getRectangle();
  return {
    x: Math.min(x, x + width),
    y: Math.min(y, y + height),
    width: Math.abs(width),
    height: Math.abs(height)
  };
}

/** pdf.js may save filled text with /Tf but no font resources in older forms. */
function fieldHasMissingFonts(
  field: PDFField,
  out: PdfDocument,
  lib: PdfLibModule
): boolean {
  const filled =
    field instanceof lib.PDFTextField
      ? Boolean(field.getText())
      : field instanceof lib.PDFDropdown || field instanceof lib.PDFOptionList
        ? field.getSelected().length > 0
        : false;
  if (!filled) return false;
  return field.acroField.getWidgets().some((widget) => {
    if (!widget.hasFlag(ANNOT_FLAG_PRINT) || widget.hasFlag(ANNOT_FLAG_HIDDEN))
      return false;
    const normal = widget.AP()?.get(lib.PDFName.of('N'));
    const appearance = normal && out.context.lookup(normal);
    if (!(appearance instanceof lib.PDFStream)) return false;
    const resources = appearance.dict.lookupMaybe(
      lib.PDFName.of('Resources'),
      lib.PDFDict
    );
    const fonts = resources?.lookupMaybe(lib.PDFName.of('Font'), lib.PDFDict);
    if (fonts && fonts.keys().length > 0) return false;
    // Some fields intentionally draw their value as outlines or an image.
    // Only text drawing needs a font resource.
    if (!(appearance instanceof lib.PDFRawStream)) return false;
    const content = new TextDecoder().decode(
      lib.decodePDFRawStream(appearance).decode()
    );
    return /\bTf\b/.test(content);
  });
}

/**
 * Draw every printable widget into its page, then drop all widgets and
 * the AcroForm. Two differences from pdf-lib's `form.flatten()`:
 *
 *   - widgets without the Print flag, or with Hidden, are dropped rather
 *     than drawn, the way a viewer prints them. "Print" and "Submit"
 *     buttons usually carry no Print flag.
 *   - widgets really leave the page. pdf-lib's `removeField` looks up the
 *     appearance ref instead of the widget ref, so the widgets stay in
 *     /Annots pointing at deleted objects.
 *
 * Throws when a printable widget has no usable appearance; the document
 * may be half-flattened by then.
 */
function flattenWidgets(
  out: PdfDocument,
  lib: PdfLibModule,
  regenerateAppearances: boolean
) {
  const form = out.getForm();
  const missingFonts = form
    .getFields()
    .filter((field) => fieldHasMissingFonts(field, out, lib));
  if (regenerateAppearances) {
    for (const field of missingFonts) form.markFieldAsDirty(field.ref);
    form.updateFieldAppearances();
  } else if (missingFonts.length > 0) {
    // If repair failed, retain the interactive form and warn instead of
    // flattening text that a PDF reader or printer cannot display.
    throw new Error('Form widget appearance has no font resources.');
  }
  const widgetType = lib.PDFName.of('Widget');
  for (const page of out.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const kept: PDFObject[] = [];
    for (const entry of annots.asArray()) {
      const dict = out.context.lookup(entry);
      if (
        !(dict instanceof lib.PDFDict) ||
        dict.get(lib.PDFName.of('Subtype')) !== widgetType
      ) {
        kept.push(entry);
        continue;
      }
      const widget = lib.PDFWidgetAnnotation.fromDict(dict);
      if (
        !widget.hasFlag(ANNOT_FLAG_PRINT) ||
        widget.hasFlag(ANNOT_FLAG_HIDDEN)
      ) {
        continue;
      }
      const appearance = widgetAppearance(widget, lib);
      if (appearance) {
        paintAppearance(page, appearance, widgetRect(widget), out, lib);
      }
    }
    page.node.set(lib.PDFName.of('Annots'), out.context.obj(kept));
  }
  out.catalog.delete(lib.PDFName.of('AcroForm'));
}

/**
 * Flatten the AcroForm in place. Returns `false` when it can't be done;
 * the document may then be half-flattened and the caller must reload it.
 */
function flattenForm(out: PdfDocument, lib: PdfLibModule): boolean {
  const acroForm = out.catalog.getAcroForm();
  if (!acroForm) return true;
  // pdf-lib drops XFA data when it opens the form, which would wipe the
  // only real content of a dynamic XFA document. Leave those alone.
  if (acroForm.dict.has(lib.PDFName.of('XFA'))) return false;
  try {
    flattenWidgets(out, lib, true);
    return true;
  } catch (err) {
    // Usually a field value Helvetica can't encode while regenerating a
    // missing appearance. Retry with the appearances the file already has.
    console.warn('[pdf/print-ready] form flatten failed, retrying', err);
  }
  try {
    flattenWidgets(out, lib, false);
    return true;
  } catch (err) {
    console.warn('[pdf/print-ready] form flatten failed', err);
    return false;
  }
}

async function loadDocument(
  lib: PdfLibModule,
  bytes: Uint8Array
): Promise<PdfDocument> {
  return lib.PDFDocument.load(bytes, {
    updateMetadata: false,
    ignoreEncryption: false
  });
}

function numbersFrom(value: unknown, lib: PdfLibModule): number[] | null {
  if (!(value instanceof lib.PDFArray)) return null;
  const numbers = value
    .asArray()
    .map((item) => (item instanceof lib.PDFNumber ? item.asNumber() : NaN));
  return numbers.every(Number.isFinite) ? numbers : null;
}

/**
 * Draw an appearance stream into the page content the way a viewer places
 * it on an annotation: the stream's /BBox, transformed by its /Matrix, is
 * fitted onto `rect` (PDF 32000-1, 12.5.5).
 */
function paintAppearance(
  page: PDFPage,
  ref: PDFRef,
  rect: PdfRect,
  out: PdfDocument,
  lib: PdfLibModule
) {
  const stream = out.context.lookup(ref);
  if (!(stream instanceof lib.PDFStream)) {
    throw new Error('Appearance is not a stream.');
  }
  const bbox = numbersFrom(stream.dict.lookup(lib.PDFName.of('BBox')), lib) ?? [
    0,
    0,
    rect.width,
    rect.height
  ];
  const matrix = numbersFrom(stream.dict.lookup(lib.PDFName.of('Matrix')), lib);
  const [a, b, c, d, e, f] = matrix?.length === 6 ? matrix : [1, 0, 0, 1, 0, 0];
  const corners = [
    [bbox[0], bbox[1]],
    [bbox[2], bbox[1]],
    [bbox[0], bbox[3]],
    [bbox[2], bbox[3]]
  ].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const width = Math.max(...xs) - minX;
  const height = Math.max(...ys) - minY;
  if (!(width > 0 && height > 0 && rect.width > 0 && rect.height > 0)) return;

  const scaleX = rect.width / width;
  const scaleY = rect.height / height;
  const name = page.node.newXObject('FlatAnnot', ref);
  page.pushOperators(
    lib.pushGraphicsState(),
    lib.concatTransformationMatrix(
      scaleX,
      0,
      0,
      scaleY,
      rect.x - minX * scaleX,
      rect.y - minY * scaleY
    ),
    lib.drawObject(name),
    lib.popGraphicsState()
  );
}

/**
 * Legacy PDF-layer ink, drawn the way the viewer draws it: one polyline
 * per stroke at its nominal width with round caps and joins.
 */
function buildPolylineInkAppearanceRef(
  strokes: PdfInkStroke[],
  fallbackColor: string,
  opacity: number,
  bbox: PdfRect,
  context: PdfContext
): PDFRef | null {
  const commands = ['q', '/GS0 gs', '1 J', '1 j'];
  for (const stroke of strokes) {
    if (stroke.points.length < 2) continue;
    const [r, g, b] = hexToRgb(stroke.color || fallbackColor);
    commands.push(
      `${pdfNumber(r)} ${pdfNumber(g)} ${pdfNumber(b)} RG`,
      `${pdfNumber(stroke.width)} w`
    );
    stroke.points.forEach((point, index) => {
      commands.push(
        `${pdfNumber(point.x - bbox.x)} ${pdfNumber(point.y - bbox.y)} ${index === 0 ? 'm' : 'l'}`
      );
    });
    commands.push('S');
  }
  if (commands.length === 4) return null;
  commands.push('Q');
  return context.register(
    context.flateStream(commands.join('\n'), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, bbox.width, bbox.height],
      Resources: {
        ExtGState: { GS0: { CA: opacity, ca: opacity } }
      }
    })
  );
}

async function paintAnnotation(
  page: PDFPage,
  annotation: PdfAnnotation,
  out: PdfDocument,
  lib: PdfLibModule
) {
  const dim = annotation.resolved ? RESOLVED_OPACITY : 1;
  const opacity = annotation.opacity * dim;
  const [r, g, b] = hexToRgb(annotation.color);
  const color = lib.rgb(r, g, b);

  switch (annotation.type) {
    case 'highlight':
      for (const rect of annotation.rects) {
        page.drawRectangle({
          ...rect,
          color,
          opacity,
          blendMode: lib.BlendMode.Multiply
        });
      }
      return;
    case 'comment': {
      // Inset by half the border so it stays inside the rect, like the
      // viewer's border-box outline.
      const inset = COMMENT_BORDER_WIDTH / 2;
      for (const rect of annotation.rects) {
        page.drawRectangle({
          x: rect.x + inset,
          y: rect.y + inset,
          width: Math.max(0, rect.width - COMMENT_BORDER_WIDTH),
          height: Math.max(0, rect.height - COMMENT_BORDER_WIDTH),
          color,
          opacity,
          borderColor: color,
          borderOpacity: dim,
          borderWidth: COMMENT_BORDER_WIDTH,
          blendMode: lib.BlendMode.Multiply
        });
      }
      return;
    }
    case 'ink': {
      if (!annotation.strokes || annotation.strokes.length === 0) return;
      const bbox = inkBounds(annotation.strokes);
      const ref = annotation.id.startsWith('shared:')
        ? buildSharedInkAppearanceRef(
            annotation.strokes,
            opacity,
            bbox,
            out.context
          )
        : buildPolylineInkAppearanceRef(
            annotation.strokes,
            annotation.color,
            opacity,
            bbox,
            out.context
          );
      if (ref) paintAppearance(page, ref, bbox, out, lib);
      return;
    }
    case 'signature': {
      if (!annotation.signature) return;
      const placement = unionRects(annotation.rects);
      const ref = await buildSignatureAppearanceRef(
        annotation.signature,
        placement,
        opacity,
        out,
        out.context
      );
      if (ref) paintAppearance(page, ref, placement, out, lib);
      return;
    }
  }
}

/**
 * A numbered circle centred on (x, y). `rotation` turns the digits so they
 * read upright once the viewer applies the page's /Rotate.
 */
function drawBadge(
  page: PDFPage,
  label: string,
  x: number,
  y: number,
  rotation: number,
  font: PDFFont,
  lib: PdfLibModule
) {
  const ink = lib.rgb(...BADGE_INK);
  page.drawCircle({
    x,
    y,
    size: BADGE_RADIUS,
    color: lib.rgb(1, 1, 1),
    borderColor: ink,
    borderWidth: 0.75
  });
  page.pushOperators(
    lib.pushGraphicsState(),
    lib.translate(x, y),
    lib.rotateDegrees(rotation)
  );
  page.drawText(label, {
    x: -font.widthOfTextAtSize(label, BADGE_FONT_SIZE) / 2,
    y: -BADGE_FONT_SIZE * 0.35,
    size: BADGE_FONT_SIZE,
    font,
    color: ink
  });
  page.pushOperators(lib.popGraphicsState());
}

function drawCommentBadge(
  page: PDFPage,
  comment: NumberedComment,
  font: PDFFont,
  lib: PdfLibModule
) {
  const rotation = normalizeRotation(page.getRotation().angle);
  const center = badgeCenter(unionRects(comment.annotation.rects), rotation);
  const box = page.getCropBox();
  const clamp = (value: number, min: number, size: number) =>
    Math.min(Math.max(value, min + BADGE_RADIUS), min + size - BADGE_RADIUS);
  drawBadge(
    page,
    String(comment.number),
    clamp(center.x, box.x, box.width),
    clamp(center.y, box.y, box.height),
    rotation,
    font,
    lib
  );
}

/**
 * Map text onto the characters `font` can encode. Characters it can't are
 * reduced to their base letters (NFKD minus combining marks) when those
 * fit, otherwise replaced with "?".
 */
function encodableText(
  text: string,
  supported: Set<number>,
  onReplace: () => void
): string {
  let result = '';
  const normalized = text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ');
  for (const char of normalized) {
    const code = char.codePointAt(0)!;
    if (supported.has(code) || char === '\n') {
      result += char;
      continue;
    }
    onReplace();
    const base = [...char.normalize('NFKD')]
      .filter((part) => supported.has(part.codePointAt(0)!))
      .join('');
    result += base || '?';
  }
  return result;
}

/** Greedy word wrap; words wider than a line are split by characters. */
function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number
): string[] {
  const fits = (value: string) =>
    font.widthOfTextAtSize(value, size) <= maxWidth;
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (fits(candidate)) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      let rest = word;
      while (!fits(rest)) {
        // Longest prefix that fits, at least one character.
        let low = 1;
        let high = rest.length - 1;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (fits(rest.slice(0, mid))) low = mid;
          else high = mid - 1;
        }
        lines.push(rest.slice(0, low));
        rest = rest.slice(low);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

/** List every numbered comment on pages appended after the document. */
function appendCommentPages(
  out: PdfDocument,
  comments: NumberedComment[],
  labels: PrintReadyLabels,
  fonts: { regular: PDFFont; bold: PDFFont },
  lib: PdfLibModule,
  text: (value: string) => string
) {
  // Match the first page as it's displayed, so a landscape document gets
  // landscape comment pages.
  const first = out.getPage(0);
  const box = first.getCropBox();
  const sideways = normalizeRotation(first.getRotation().angle) % 180 !== 0;
  const pageSize: [number, number] = sideways
    ? [box.height, box.width]
    : [box.width, box.height];
  const contentWidth = pageSize[0] - PAGE_MARGIN * 2 - ENTRY_INDENT;
  const ink = lib.rgb(...BADGE_INK);

  let page = out.addPage(pageSize);
  let y = pageSize[1] - PAGE_MARGIN - HEADING_SIZE;
  page.drawText(text(labels.commentsHeading), {
    x: PAGE_MARGIN,
    y,
    size: HEADING_SIZE,
    font: fonts.bold,
    color: ink
  });
  y -= HEADING_SIZE + ENTRY_GAP;

  for (const comment of comments) {
    const pageRef = labels.page.replace(
      '{page}',
      String(comment.annotation.pageIndex + 1)
    );
    const title = comment.annotation.resolved
      ? `${pageRef} · ${labels.resolved}`
      : pageRef;
    const lines = wrapText(
      text(comment.body),
      fonts.regular,
      BODY_SIZE,
      contentWidth
    );

    // Keep the title together with the first line of its body.
    if (y - LINE_HEIGHT * 2 < PAGE_MARGIN) {
      page = out.addPage(pageSize);
      y = pageSize[1] - PAGE_MARGIN - LINE_HEIGHT;
    }
    drawBadge(
      page,
      String(comment.number),
      PAGE_MARGIN + BADGE_RADIUS,
      y + ENTRY_TITLE_SIZE * 0.35,
      0,
      fonts.bold,
      lib
    );
    page.drawText(text(title), {
      x: PAGE_MARGIN + ENTRY_INDENT,
      y,
      size: ENTRY_TITLE_SIZE,
      font: fonts.bold,
      color: ink
    });
    y -= LINE_HEIGHT;

    for (const line of lines) {
      if (y < PAGE_MARGIN) {
        page = out.addPage(pageSize);
        y = pageSize[1] - PAGE_MARGIN - LINE_HEIGHT;
      }
      page.drawText(line, {
        x: PAGE_MARGIN + ENTRY_INDENT,
        y,
        size: BODY_SIZE,
        font: fonts.regular,
        color: ink
      });
      y -= LINE_HEIGHT;
    }
    y -= ENTRY_GAP;
  }
}

/**
 * Build the print-ready copy. Pure like `exportAnnotatedPdf`: bytes in,
 * bytes out. `sourceBytes` should already carry the note's form values.
 */
export async function exportPrintReadyPdf(
  sourceBytes: Uint8Array,
  annotations: PdfAnnotation[],
  labels: PrintReadyLabels
): Promise<PrintReadyResult> {
  const lib = await import('pdf-lib');
  const warnings = new Set<PrintReadyWarning>();

  let out = await loadDocument(lib, sourceBytes);
  if (!flattenForm(out, lib)) {
    warnings.add('form-not-flattened');
    out = await loadDocument(lib, sourceBytes);
  }

  const pages = out.getPages();
  const live = annotations.filter(
    (annotation) =>
      !annotation.deletedAt &&
      annotation.pageIndex >= 0 &&
      annotation.pageIndex < pages.length
  );
  for (const annotation of live) {
    await paintAnnotation(pages[annotation.pageIndex], annotation, out, lib);
  }

  const comments = numberComments(live);
  if (comments.length > 0) {
    const fonts = {
      regular: await out.embedFont(lib.StandardFonts.Helvetica),
      bold: await out.embedFont(lib.StandardFonts.HelveticaBold)
    };
    // Both fonts share the WinAnsi character set.
    const supported = new Set(fonts.regular.getCharacterSet());
    const text = (value: string) =>
      encodableText(value, supported, () =>
        warnings.add('unsupported-characters')
      );
    for (const comment of comments) {
      drawCommentBadge(
        pages[comment.annotation.pageIndex],
        comment,
        fonts.bold,
        lib
      );
    }
    appendCommentPages(out, comments, labels, fonts, lib, text);
  }

  return { bytes: await out.save(), warnings: [...warnings] };
}
