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

// ── Spacing (px) ────────────────────────────────────────────────────

/** Vertical gap between consecutive pages — mirrors `gap-4`. */
export const PAGE_GAP = 16;

/** Horizontal padding around the scrollable page column — `px-3`. */
export const PAGE_SCROLL_PADDING_X = 12;

/** Vertical padding around the scrollable page column — `py-4`. */
export const PAGE_SCROLL_PADDING_Y = 16;

/**
 * Gutter (px) kept on EACH side between a fitted page and the viewport
 * edge, so a fit-to-width render never kisses the container. Both the
 * PDF viewer and the ink editor apply it per side (multiply by 2 for
 * the total horizontal inset), so an A4 page fills the column the same
 * way in either renderer.
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

/** Scroll container that holds the centred page column. */
export const PAGE_SCROLLER_CLASS = 'overflow-auto px-3 py-4';

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
