/**
 * Geometry helpers shared between the annotation render layer, the
 * signature pad, and the exporter. All coordinates are in whatever
 * space the caller is working in (PDF user space, viewport pixels,
 * or pad-local) — the helpers are unit-agnostic.
 */

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
