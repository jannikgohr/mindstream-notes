/**
 * Page layout spacing + surface presentation, extracted from the PDF
 * viewer (`PdfNoteViewer.svelte`) so every page-based module renders
 * its pages with the same breathing room and the same "sheet resting
 * on a desk" look.
 *
 * Two kinds of renderer consume this module:
 *
 *  - **DOM** modules (the PDF viewer) apply the Tailwind class strings
 *    to real elements.
 *  - **Canvas** modules (the ink editor) read the numeric / colour
 *    tokens, because a `<canvas>`-drawn page can't wear a CSS class.
 *
 * The class strings and the numeric constants intentionally describe
 * the SAME spacing (e.g. `PAGE_GAP` === `gap-4` === 16px). If you tune
 * one, tune its twin.
 */

// ── Page size ───────────────────────────────────────────────────────

/**
 * ISO A4 page, expressed in ink-document units.
 *
 * 1190×1684 is exactly 2× the 595×842 pt A4 page PDF.js renders, so an
 * ink page and an A4 PDF page share identical proportions and frame the
 * same way at fit-width. (595×842 is the conventional A4 rounding — a
 * hair, ~0.06%, taller than the 210:297 ideal — but matching the PDF is
 * what page parity needs, so we mirror it rather than the ideal.)
 *
 * The ink editor's pages are always this size; only the page *count*
 * grows. A note looking "taller" than a PDF is the editor's trailing
 * blank page + 2-page minimum (room to keep drawing), not the page.
 */
export const A4_PAGE: { width: number; height: number } = {
  width: 1190,
  height: 1684
};

// ── Spacing (px) ────────────────────────────────────────────────────

/** Vertical gap between consecutive pages — mirrors `gap-4`. */
export const PAGE_GAP = 16;

/** Vertical padding around the scrollable page column — `py-4`. */
export const PAGE_SCROLL_PADDING_Y = 16;

/**
 * The page's normal breathing-room margin (px), kept on each side of a
 * fitted page. Applied per side by both the PDF viewer (fit-width) and
 * the ink editor (fit-width side gutter, top gap, and pan clamp).
 *
 * Because the page scrollbar is overlaid (it takes no layout width — see
 * the consumers), this single margin is all that insets the page: both
 * renderers fit an A4 page to the full panel width minus 2× this margin,
 * so they're the same size and centred regardless of page count. No
 * extra scrollbar gutter is reserved — there's no scrollbar width to
 * reserve.
 */
export const PAGE_FIT_MARGIN = 16;

/**
 * Extra room (px) reserved above the page when fitting the *whole*
 * sheet on screen, leaving space for floating chrome (selection /
 * rotate handles). Used by the ink editor's zoom-out floor; available
 * to any module that floats UI over the top of the page.
 */
export const PAGE_FIT_TOP_MARGIN = 72;

// ── DOM surface (Tailwind class strings) ────────────────────────────

/**
 * Scroll container that holds the centred page column. No horizontal
 * padding: the side gutter comes entirely from {@link PAGE_FIT_MARGIN}
 * (the page fits to a width that already reserves it), and the vertical
 * scrollbar is overlaid via {@link PAGE_SCROLLER_SCROLLBAR_CLASS} so it
 * never steals width or shifts the page off-centre.
 */
export const PAGE_SCROLLER_CLASS = 'overflow-auto py-4';

/**
 * Overlay the page scrollbar: hide the native bar so it occupies no
 * layout width (the page stays full-width and centred regardless of
 * page count) while the container still scrolls via wheel / trackpad /
 * drag. WebView2/Chromium has no native overlay scrollbar, so "overlay"
 * here means "hidden footprint".
 */
export const PAGE_SCROLLER_SCROLLBAR_CLASS = 'scrollbar-none';

/** Centred, content-width column the pages stack inside. */
export const PAGE_COLUMN_CLASS =
  'mx-auto flex w-max min-w-full flex-col items-center gap-4';

/** A single page "sheet": white fill, soft drop shadow, hairline ring. */
export const PAGE_SURFACE_CLASS = 'bg-white shadow-sm ring-1 ring-border';

// ── Canvas surface (drawing tokens) ─────────────────────────────────

export interface CanvasPageSurface {
  /** Drop-shadow colour painted behind the page. */
  shadowColor: string;
  /** Drop-shadow blur radius, px. */
  shadowBlur: number;
  /** Drop-shadow vertical offset, px. */
  shadowOffsetY: number;
  /** Hairline border drawn around the page edge. */
  edgeColor: string;
}

const CANVAS_PAGE_SURFACE_LIGHT: CanvasPageSurface = {
  shadowColor: 'rgba(15, 23, 42, 0.16)',
  shadowBlur: 14,
  shadowOffsetY: 6,
  edgeColor: 'rgba(15, 23, 42, 0.08)'
};

const CANVAS_PAGE_SURFACE_DARK: CanvasPageSurface = {
  shadowColor: 'rgba(0, 0, 0, 0.42)',
  shadowBlur: 18,
  shadowOffsetY: 8,
  edgeColor: 'rgba(255, 255, 255, 0.12)'
};

/**
 * Page-surface drawing tokens for the active app theme — the canvas
 * equivalent of {@link PAGE_SURFACE_CLASS}'s shadow + ring.
 */
export function canvasPageSurface(dark: boolean): CanvasPageSurface {
  return dark ? CANVAS_PAGE_SURFACE_DARK : CANVAS_PAGE_SURFACE_LIGHT;
}
