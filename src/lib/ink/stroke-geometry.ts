/**
 * Pure stroke geometry: hit testing against a point or a lasso, bounding
 * boxes, and the tile keys the spatial index buckets strokes into.
 *
 * Nothing here touches Yjs or the document — every function is a plain
 * value transform, which is what makes the eraser and lasso behaviour
 * unit-testable.
 */

import { pointToSegmentDistanceSq, type InkPoint } from '$lib/ink/page';
import type { InkStroke, StrokeBounds, StrokeMeta } from './stroke-types';

export function strokesHitAt(
  strokes: InkStroke[],
  point: { x: number; y: number },
  radius: number
): InkStroke[] {
  return strokes.filter((stroke) =>
    strokeHitAt(
      { ...stroke, bounds: boundsOfPoints(stroke.points) },
      point,
      radius
    )
  );
}

export function strokeHitAt(
  stroke: StrokeMeta,
  point: { x: number; y: number },
  radius: number
): boolean {
  if (!boundsContainPoint(stroke.bounds, point, radius)) return false;
  const radiusSq = radius * radius;
  for (let i = 1; i < stroke.points.length; i += 1) {
    if (
      pointToSegmentDistanceSq(point, stroke.points[i - 1], stroke.points[i]) <=
      radiusSq
    ) {
      return true;
    }
  }
  return false;
}

export function strokeIntersectsLasso(
  stroke: StrokeMeta,
  lasso: Array<{ x: number; y: number }>
): boolean {
  if (lasso.length < 3) return false;
  for (const point of stroke.points) {
    if (pointInPolygon(point, lasso)) return true;
  }
  for (let i = 1; i < stroke.points.length; i += 1) {
    const a = stroke.points[i - 1];
    const b = stroke.points[i];
    for (let j = 0; j < lasso.length; j += 1) {
      const c = lasso[j];
      const d = lasso[(j + 1) % lasso.length];
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

export function pointInPolygon(
  point: { x: number; y: number },
  polygon: Array<{ x: number; y: number }>
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function segmentsIntersect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number }
): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);

  if (abC === 0 && pointOnSegment(c, a, b)) return true;
  if (abD === 0 && pointOnSegment(d, a, b)) return true;
  if (cdA === 0 && pointOnSegment(a, c, d)) return true;
  if (cdB === 0 && pointOnSegment(b, c, d)) return true;

  return abC !== abD && cdA !== cdB;
}

export function orientation(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number }
): -1 | 0 | 1 {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < 1e-6) return 0;
  return value > 0 ? 1 : -1;
}

export function pointOnSegment(
  point: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number }
): boolean {
  return (
    point.x >= Math.min(a.x, b.x) - 1e-6 &&
    point.x <= Math.max(a.x, b.x) + 1e-6 &&
    point.y >= Math.min(a.y, b.y) - 1e-6 &&
    point.y <= Math.max(a.y, b.y) + 1e-6
  );
}

export function boundsOfPoints(points: InkPoint[]): StrokeBounds {
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
  if (minX === Number.POSITIVE_INFINITY) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  return { minX, minY, maxX, maxY };
}

export function boundsContainPoint(
  bounds: StrokeBounds,
  point: { x: number; y: number },
  padding: number
): boolean {
  return (
    point.x >= bounds.minX - padding &&
    point.x <= bounds.maxX + padding &&
    point.y >= bounds.minY - padding &&
    point.y <= bounds.maxY + padding
  );
}

export function boundsIntersect(
  a: StrokeBounds,
  b: StrokeBounds,
  padding: number
): boolean {
  return (
    a.maxX + padding >= b.minX &&
    a.minX - padding <= b.maxX &&
    a.maxY + padding >= b.minY &&
    a.minY - padding <= b.maxY
  );
}

export function tileCoord(value: number, tileSize: number): number {
  return Math.floor(value / tileSize);
}

export function tileKey(x: number, y: number): string {
  return `${x}:${y}`;
}
