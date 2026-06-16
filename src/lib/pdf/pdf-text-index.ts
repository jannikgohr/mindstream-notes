/**
 * In-document text search support for the PDF viewer.
 *
 * The viewer renders pages with a custom virtualized pipeline (only pages
 * near the viewport get a real text layer), so pdf.js's own
 * `PDFFindController` — which drives highlighting through the live text
 * layer of a full `PDFViewer` — can't be wired in directly. Instead we
 * build a lightweight per-page text index from `getTextContent()` and
 * compute match rectangles in PDF user space, which the viewer overlays
 * the same way it overlays annotations.
 *
 * Coordinates here match the annotation model: PDF user space, origin
 * bottom-left, Y up — i.e. directly consumable by
 * `viewport.convertToViewportPoint`.
 */

import type { PdfRect } from './types';

/** One rendered text item, with its char range inside the page string. */
export type PageTextSegment = {
  /** Inclusive start offset of this item's chars in `PageTextIndex.text`. */
  start: number;
  /** Exclusive end offset. */
  end: number;
  /** Left edge (PDF user space). */
  x: number;
  /** Baseline Y (PDF user space, Y up). */
  y: number;
  /** Item advance width in user-space units. */
  width: number;
  /** Glyph box height in user-space units. */
  height: number;
  /** Character count — `end - start`. */
  length: number;
};

export type PageTextIndex = {
  /** Lowercased concatenation of every text item on the page. */
  text: string;
  segments: PageTextSegment[];
};

export type PdfSearchMatch = {
  /** Stable id: `${pageIndex}:${charOffset}`. */
  id: string;
  pageIndex: number;
  /** One rect per text item the match spans. */
  rects: PdfRect[];
};

type TextContentItemLike = {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
};

type TextContentLike = { items: unknown[] };

type PageLike = {
  getTextContent: () => Promise<TextContentLike>;
};

const ENDS_WITH_SPACE = /\s$/;
const STARTS_WITH_SPACE = /^\s/;

/**
 * Build a searchable text index for one page. Adjacent items that would
 * otherwise glue two words together get a single separating space; that
 * separator belongs to no segment, so it never produces a match rect.
 */
export async function buildPageTextIndex(
  page: PageLike
): Promise<PageTextIndex> {
  const content = await page.getTextContent();
  let text = '';
  const segments: PageTextSegment[] = [];
  let prevEndedWithSpace = true;
  // Geometry of the previous real text item, for gap/line detection.
  let prevEndX = 0;
  let prevY = 0;
  let prevHeight = 0;

  for (const raw of content.items) {
    const item = raw as TextContentItemLike;
    // Marked-content items carry no `str` and no geometry — skip them
    // without disturbing the previous-item geometry.
    if (typeof item.str !== 'string') continue;
    const str = item.str;
    if (str.length === 0) {
      if (item.hasEOL) prevEndedWithSpace = true;
      continue;
    }

    const transform = item.transform ?? [1, 0, 0, 1, 0, 0];
    const x = transform[4] ?? 0;
    const y = transform[5] ?? 0;
    // height occasionally comes back as 0; fall back to the font size
    // derived from the transform matrix.
    const height =
      (item.height && item.height > 0 ? item.height : 0) ||
      Math.hypot(transform[2] ?? 0, transform[3] ?? 0) ||
      Math.hypot(transform[0] ?? 0, transform[1] ?? 0) ||
      1;
    const width = item.width && item.width > 0 ? item.width : 0;

    // Synthesize a separating space only when two items shouldn't be read
    // as one word: a different baseline (new line) or a real horizontal
    // gap. Contiguous glyphs on the same line stay glued so "ab" split
    // across two items still matches the query "ab".
    if (
      !prevEndedWithSpace &&
      !STARTS_WITH_SPACE.test(str) &&
      text.length > 0
    ) {
      const sameLine =
        Math.abs(y - prevY) <= Math.max(prevHeight, height) * 0.5;
      const gap = x - prevEndX;
      if (!sameLine || gap > 0.2 * Math.max(prevHeight, height, 1)) {
        text += ' ';
      }
    }

    const start = text.length;
    text += str;
    segments.push({
      start,
      end: text.length,
      x,
      y,
      width,
      height,
      length: str.length
    });

    prevEndedWithSpace = ENDS_WITH_SPACE.test(str);
    prevEndX = x + width;
    prevY = y;
    prevHeight = height;
    if (item.hasEOL) {
      text += ' ';
      prevEndedWithSpace = true;
    }
  }

  return { text: text.toLowerCase(), segments };
}

/**
 * Compute the highlight rectangles covering the character range
 * `[from, to)`. A range that spans several text items yields one rect per
 * item; per-item character widths are approximated uniformly, which is
 * accurate enough for a translucent search highlight.
 */
function rectsForRange(
  segments: PageTextSegment[],
  from: number,
  to: number
): PdfRect[] {
  const rects: PdfRect[] = [];
  for (const seg of segments) {
    if (seg.end <= from || seg.start >= to) continue;
    const localStart = Math.max(from, seg.start) - seg.start;
    const localEnd = Math.min(to, seg.end) - seg.start;
    if (localEnd <= localStart) continue;
    const charWidth = seg.length > 0 ? seg.width / seg.length : 0;
    const x = seg.x + localStart * charWidth;
    const width = (localEnd - localStart) * charWidth || seg.width;
    rects.push({ x, y: seg.y, width, height: seg.height });
  }
  return rects;
}

/**
 * Find every (non-overlapping) occurrence of `query` on a page. `query`
 * is matched case-insensitively. Returns matches in reading order.
 */
export function findMatchesInPage(
  index: PageTextIndex,
  pageIndex: number,
  query: string
): PdfSearchMatch[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const matches: PdfSearchMatch[] = [];
  let from = 0;
  for (;;) {
    const at = index.text.indexOf(needle, from);
    if (at === -1) break;
    matches.push({
      id: `${pageIndex}:${at}`,
      pageIndex,
      rects: rectsForRange(index.segments, at, at + needle.length)
    });
    from = at + needle.length;
  }
  return matches;
}
