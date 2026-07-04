/**
 * Geometry helpers shared between the annotation render layer, the
 * signature pad, and the exporter. All coordinates are in whatever
 * space the caller is working in (PDF user space, viewport pixels,
 * or pad-local) — the helpers are unit-agnostic.
 */

import { getStroke } from 'perfect-freehand';
import type {
  PdfInkStroke,
  PdfRect,
  PdfSignatureSnapshot,
  PdfStrokePoint
} from './types';

/** SVG `points` attribute for a `<polyline>`. */
export function strokePointsAttr(points: PdfStrokePoint[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(' ');
}

/**
 * Filled-outline SVG path for a variable-width stroke (render with
 * `fill={stroke.color}`, no stroke). Point `pressure` scales the local
 * width around `stroke.width`; pressures are normalised to their mean
 * per stroke, so uniform-pressure strokes — everything hand-drawn with
 * a mouse (constant 0.5) or old saved signatures — render at exactly
 * the nominal width, identical to the previous fixed-width polylines.
 * Traced photo imports store measured widths as mean-relative pressure
 * (see signature-trace.ts fitToPad), which this renders faithfully.
 */
export function strokeOutlinePath(
  stroke: Pick<PdfInkStroke, 'points' | 'width'>
): string {
  const { points, width } = stroke;
  if (points.length === 0) return '';

  let sum = 0;
  for (const p of points) sum += p.pressure ?? 1;
  const mean = sum / points.length || 1;

  const outline = getStroke(
    points.map((p) => [p.x, p.y, (p.pressure ?? 1) / mean]),
    {
      size: width,
      // thinning 1 + simulatePressure off ⇒ local width = size × pressure.
      thinning: 1,
      smoothing: 0.5,
      streamline: 0.3,
      simulatePressure: false,
      last: true
    }
  );
  if (outline.length < 3) return '';

  // Midpoint-quadratic smoothing of the outline polygon (the standard
  // perfect-freehand companion snippet).
  const d: string[] = [
    `M ${outline[0][0].toFixed(2)} ${outline[0][1].toFixed(2)} Q`
  ];
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % outline.length];
    d.push(
      `${x0.toFixed(2)} ${y0.toFixed(2)} ${((x0 + x1) / 2).toFixed(2)} ${(
        (y0 + y1) /
        2
      ).toFixed(2)}`
    );
  }
  d.push('Z');
  return d.join(' ');
}

/**
 * Axis-aligned bounding box around a set of points, optionally padded.
 * Returns a zero-area rect at the origin when given no points so callers
 * don't have to special-case empty input.
 */
export function strokeBounds(points: PdfStrokePoint[], padding = 0): PdfRect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2
  };
}

/** A copy of the stroke with every point shifted by `(dx, dy)`. */
export function translateStroke(
  stroke: PdfInkStroke,
  dx: number,
  dy: number
): PdfInkStroke {
  return {
    ...stroke,
    points: stroke.points.map((point) => ({
      ...point,
      x: point.x + dx,
      y: point.y + dy
    }))
  };
}

/** A copy of the rect shifted by `(dx, dy)`. */
export function translateRect(rect: PdfRect, dx: number, dy: number): PdfRect {
  return { ...rect, x: rect.x + dx, y: rect.y + dy };
}

/** Deep-copy an ink stroke so the result shares no references with the input. */
export function cloneInkStroke(stroke: PdfInkStroke): PdfInkStroke {
  return {
    id: stroke.id,
    color: stroke.color,
    width: stroke.width,
    points: stroke.points.map((point) => ({ ...point }))
  };
}

/** Deep-copy a signature snapshot. */
export function cloneSignatureSnapshot(
  signature: PdfSignatureSnapshot
): PdfSignatureSnapshot {
  return {
    id: signature.id,
    width: signature.width,
    height: signature.height,
    strokes: signature.strokes.map(cloneInkStroke)
  };
}
