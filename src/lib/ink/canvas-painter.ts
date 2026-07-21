/**
 * Painting the ink canvas: the page sheets, their background patterns,
 * and a single stroke.
 *
 * These are the primitives the editor's frame loop calls. They take the
 * scene they need as an argument instead of closing over the component,
 * so what a page or a stroke actually looks like is decided in one place
 * and can be exercised against a stub 2D context.
 */

import {
  PAGE_FILL_LIGHT,
  PAGE_GRID_STEP,
  PAGE_PATTERN_DOT_ALPHA,
  PAGE_PATTERN_LINE_ALPHA,
  PAGE_RULE_STEP,
  centeredPatternPositions,
  pressureWidth,
  type PageBackgroundMode
} from '$lib/ink/editor-helpers';
import { canvasPageSurface } from '$lib/layout/page-layout';
import {
  pageRect,
  strideY,
  type DocumentLayout,
  type InkPoint
} from '$lib/ink/page';
import type { StrokeBounds } from '$lib/ink/stroke-types';
import { pageToScreen, type InkView } from '$lib/ink/view-transform';

/** Everything the painters need to know about the scene being drawn. */
export interface InkScene {
  view: InkView;
  layout: DocumentLayout;
  /** Page theme, which inverts the palette rather than the app theme. */
  pageDark: boolean;
  pageBackground: PageBackgroundMode;
  pageBackgroundColorRgb: number;
  pageBackgroundOpacity: number;
  /** Maps a stored ARGB colour to the CSS colour for the current theme. */
  displayCssColor(argb: number): string;
}

export function visiblePageBounds(view: InkView): StrokeBounds {
  return {
    minX: -view.panX / view.scale,
    minY: -view.panY / view.scale,
    maxX: (view.width - view.panX) / view.scale,
    maxY: (view.height - view.panY) / view.scale
  };
}

export function drawPages(
  ctx: CanvasRenderingContext2D,
  visible: StrokeBounds,
  scene: InkScene
) {
  const { view, layout, pageDark, displayCssColor } = scene;
  const stride = strideY(layout);
  const firstPage = Math.max(0, Math.floor(visible.minY / stride) - 1);
  const lastPage = Math.min(
    layout.pageCount - 1,
    Math.floor(visible.maxY / stride) + 1
  );
  for (let i = firstPage; i <= lastPage; i += 1) {
    const rect = pageRect(layout, i);
    if (!rect) continue;
    const [x0, y0, x1, y1] = rect;
    const a = pageToScreen(view, { x: x0, y: y0 });
    const b = pageToScreen(view, { x: x1, y: y1 });
    if (b.y < -32 || a.y > view.height + 32) continue;
    const width = b.x - a.x;
    const height = b.y - a.y;
    const surface = canvasPageSurface(pageDark);
    ctx.save();
    ctx.shadowColor = surface.shadowColor;
    ctx.shadowBlur = surface.shadowBlur;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = surface.shadowOffsetY;
    ctx.fillStyle = displayCssColor(PAGE_FILL_LIGHT);
    ctx.fillRect(a.x, a.y, width, height);
    ctx.restore();
    drawPageBackground(ctx, a, b, scene);
    ctx.strokeStyle = surface.edgeColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, width - 1, height - 1);
  }
}

/**
 * Paint the selected page-background pattern (dots / ruled lines /
 * grid) inside one page, clipped to its rect. Steps are page-unit
 * spacings scaled to screen px and anchored to the page's top-left so
 * the pattern is stable under pan/zoom. The pattern colour runs
 * through `displayCssColor` so dark mode inverts it to faint light
 * marks. Bails when zoomed out far enough that the pattern would turn
 * into a solid wash.
 */
export function drawPageBackground(
  ctx: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number },
  scene: InkScene
) {
  const {
    view,
    pageBackground,
    pageBackgroundColorRgb,
    pageBackgroundOpacity,
    displayCssColor
  } = scene;
  if (pageBackground === 'clear') return;
  const scale = view.scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.clip();
  if (pageBackground === 'points') {
    const step = PAGE_GRID_STEP * scale;
    if (step >= 3) {
      const alpha = Math.round(PAGE_PATTERN_DOT_ALPHA * pageBackgroundOpacity);
      if (alpha <= 0) {
        ctx.restore();
        return;
      }
      const radius = Math.max(0.8, Math.min(1.6, 1.1 * scale * 2));
      ctx.fillStyle = displayCssColor(
        ((alpha << 24) | pageBackgroundColorRgb) >>> 0
      );
      for (const y of centeredPatternPositions(a.y, b.y, step)) {
        for (const x of centeredPatternPositions(a.x, b.x, step)) {
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  } else {
    const stepY =
      (pageBackground === 'lines' ? PAGE_RULE_STEP : PAGE_GRID_STEP) * scale;
    if (stepY >= 3) {
      const alpha = Math.round(PAGE_PATTERN_LINE_ALPHA * pageBackgroundOpacity);
      if (alpha <= 0) {
        ctx.restore();
        return;
      }
      ctx.strokeStyle = displayCssColor(
        ((alpha << 24) | pageBackgroundColorRgb) >>> 0
      );
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const y of centeredPatternPositions(a.y, b.y, stepY)) {
        const py = Math.round(y) + 0.5;
        ctx.moveTo(a.x, py);
        ctx.lineTo(b.x, py);
      }
      if (pageBackground === 'grid') {
        const stepX = PAGE_GRID_STEP * scale;
        for (const x of centeredPatternPositions(a.x, b.x, stepX)) {
          const px = Math.round(x) + 0.5;
          ctx.moveTo(px, a.y);
          ctx.lineTo(px, b.y);
        }
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * Paint one stroke as a run of line segments whose width follows pen
 * pressure. The width is quantised to quarter-pixels and the path is
 * only restarted when it actually changes, which keeps a long stroke to
 * a handful of `stroke()` calls instead of one per segment.
 */
export function drawStroke(
  ctx: CanvasRenderingContext2D,
  points: InkPoint[],
  color: string,
  baseWidth: number,
  view: InkView
) {
  if (points.length < 2) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  const scale = view.scale;
  const panX = view.panX;
  const panY = view.panY;
  let previous = points[0];
  let previousX = previous.x * scale + panX;
  let previousY = previous.y * scale + panY;
  let currentWidth = 0;
  let pathOpen = false;

  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    const x = point.x * scale + panX;
    const y = point.y * scale + panY;
    const pressure = (previous.pressure + point.pressure) * 0.5;
    const lineWidth = Math.max(1, baseWidth * scale * pressureWidth(pressure));
    const quantizedWidth = Math.round(lineWidth * 4) / 4;
    if (!pathOpen || quantizedWidth !== currentWidth) {
      if (pathOpen) {
        ctx.stroke();
      }
      ctx.lineWidth = quantizedWidth;
      ctx.beginPath();
      ctx.moveTo(previousX, previousY);
      currentWidth = quantizedWidth;
      pathOpen = true;
    }
    ctx.lineTo(x, y);
    previous = point;
    previousX = x;
    previousY = y;
  }
  if (pathOpen) {
    ctx.stroke();
  }
}
