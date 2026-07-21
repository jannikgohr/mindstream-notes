/**
 * The ink canvas viewport: scale, pan, and the conversions between screen
 * and page coordinates.
 *
 * Everything here is a pure function of a viewport plus the document
 * layout — no canvas, no DOM, no component state. The editor keeps the
 * live viewport and applies the results; the rules for what a legal
 * viewport is (never smaller than fit-to-screen, never panned past the
 * content, centred when the content is narrower than the window) live
 * here where they can be reasoned about and tested on their own.
 */

import { PAGE_FIT_MARGIN, PAGE_FIT_TOP_MARGIN } from '$lib/layout/page-layout';
import {
  DEFAULT_PAGE_GAP,
  type DocumentLayout,
  type InkPoint
} from '$lib/ink/page';
import {
  INK_ZOOM_DISPLAY_SCALE,
  MAX_ZOOM_FACTOR
} from '$lib/ink/editor-helpers';

/** The scale below which we never zoom out, whatever the window size. */
const ABSOLUTE_MIN_SCALE = 0.05;

/** Gutter kept between the content edge and the window when panning. */
const PAN_EDGE_GUTTER = 16;

export interface InkView {
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
  scale: number;
  panX: number;
  panY: number;
}

export function defaultView(): InkView {
  return { width: 1, height: 1, scale: 1, panX: 0, panY: DEFAULT_PAGE_GAP };
}

/**
 * The zoom percentage shown in the UI. The canvas scale and the number
 * the user sees differ by a fixed factor, so a "100%" ink page reads at
 * a comfortable size rather than matching CSS pixels exactly.
 */
export function displayInkZoom(scale: number): number {
  return scale * INK_ZOOM_DISPLAY_SCALE;
}

/** Inverse of {@link displayInkZoom}. */
export function scaleFromDisplayInkZoom(value: number): number {
  return value / INK_ZOOM_DISPLAY_SCALE;
}

/** The scale at which a whole page fits the window. */
export function minScale(view: InkView, layout: DocumentLayout): number {
  const availableWidth = Math.max(1, view.width - PAGE_FIT_MARGIN * 2);
  const availableHeight = Math.max(
    1,
    view.height - PAGE_FIT_TOP_MARGIN - PAGE_FIT_MARGIN
  );
  return Math.max(
    ABSOLUTE_MIN_SCALE,
    Math.min(
      availableWidth / layout.page.width,
      availableHeight / layout.page.height
    )
  );
}

/** The scale at which a page fills the window's width. */
export function fitWidthScale(view: InkView, layout: DocumentLayout): number {
  const availableWidth = Math.max(1, view.width - PAGE_FIT_MARGIN * 2);
  return Math.max(minScale(view, layout), availableWidth / layout.page.width);
}

/** Total height of every page plus the gaps between them, unscaled. */
function contentHeight(layout: DocumentLayout): number {
  return (
    layout.page.height * layout.pageCount +
    layout.pageGap * (layout.pageCount - 1)
  );
}

export function screenToPage(view: InkView, x: number, y: number): InkPoint {
  return {
    x: (x - view.panX) / view.scale,
    y: (y - view.panY) / view.scale,
    pressure: 1
  };
}

export function pageToScreen(
  view: InkView,
  point: { x: number; y: number }
): { x: number; y: number } {
  return {
    x: point.x * view.scale + view.panX,
    y: point.y * view.scale + view.panY
  };
}

/**
 * Pull a viewport back into legal range.
 *
 * Horizontally and vertically the content is centred when it is smaller
 * than the window and clamped to its edges when it is larger. The top
 * margin grows on mobile, where the toolbar overlays the canvas.
 */
export function clampView(
  view: InkView,
  layout: DocumentLayout,
  options: { mobileToolbar: boolean }
): InkView {
  const scale = Math.max(view.scale, minScale(view, layout));
  const contentW = layout.page.width * scale;
  const contentH = contentHeight(layout) * scale;

  const panX =
    contentW <= view.width
      ? (view.width - contentW) * 0.5
      : Math.min(
          PAN_EDGE_GUTTER,
          Math.max(view.width - contentW - PAN_EDGE_GUTTER, view.panX)
        );

  const bottomMargin = Math.max(PAGE_FIT_MARGIN, layout.pageGap * scale);
  const topMargin = options.mobileToolbar
    ? Math.max(PAGE_FIT_TOP_MARGIN, bottomMargin)
    : PAGE_FIT_MARGIN;
  const minY = view.height - contentH - bottomMargin;
  const maxY = topMargin;
  const panY =
    minY <= maxY
      ? Math.min(maxY, Math.max(minY, view.panY))
      : (view.height - contentH) * 0.5;

  return { ...view, scale, panX, panY };
}

/** Fit the page width, top-aligned with the same gutter the sides get. */
export function fitWidthView(
  view: InkView,
  layout: DocumentLayout,
  options: { mobileToolbar: boolean }
): InkView {
  const scale = fitWidthScale(view, layout);
  return clampView(
    {
      ...view,
      scale,
      panX: (view.width - layout.page.width * scale) * 0.5,
      panY: PAGE_FIT_MARGIN
    },
    layout,
    options
  );
}

/** Clamp a requested scale to the legal zoom range. */
export function clampScale(
  view: InkView,
  layout: DocumentLayout,
  scale: number
): number {
  const min = minScale(view, layout);
  return Math.min(Math.max(scale, min), min * MAX_ZOOM_FACTOR);
}

/**
 * Zoom while keeping the page point currently under `(screenX, screenY)`
 * under that same screen position — the anchor behaviour a pinch or a
 * ctrl+wheel needs.
 *
 * Not clamped: the caller decides whether the gesture should settle
 * inside the legal pan range (a wheel zoom does, a live pinch doesn't,
 * so the content can rubber-band under the fingers).
 */
export function zoomAroundPoint(
  view: InkView,
  layout: DocumentLayout,
  screenX: number,
  screenY: number,
  scale: number
): InkView {
  const before = screenToPage(view, screenX, screenY);
  const next = clampScale(view, layout, scale);
  return {
    ...view,
    scale: next,
    panX: screenX - before.x * next,
    panY: screenY - before.y * next
  };
}

/** Zoom to a scale, anchored on the middle of the window. */
export function zoomToScale(
  view: InkView,
  layout: DocumentLayout,
  scale: number,
  options: { mobileToolbar: boolean }
): InkView {
  const zoomed = zoomAroundPoint(
    view,
    layout,
    view.width * 0.5,
    view.height * 0.5,
    scale
  );
  return clampView(zoomed, layout, options);
}
