/**
 * Geometry for the "partial" (true) ink eraser: cut a polyline stroke into
 * the pieces that survive after removing every part covered by a set of
 * eraser circles. Pure and unit-tested; the Yjs document layer turns the
 * surviving pieces back into strokes.
 */

import type { InkPoint } from './page';

export interface EraserCircle {
  x: number;
  y: number;
  r: number;
}

interface Interval {
  a: number;
  b: number;
}

const EPS = 1e-9;

function lerpPoint(a: InkPoint, b: InkPoint, t: number): InkPoint {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    pressure: a.pressure + (b.pressure - a.pressure) * t
  };
}

/**
 * The sub-interval of the segment `a`→`b` (parametrised t ∈ [0, 1]) that
 * lies inside `circle`, or null if the segment never enters it.
 */
function segmentInsideCircle(
  a: InkPoint,
  b: InkPoint,
  circle: EraserCircle
): Interval | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - circle.x;
  const fy = a.y - circle.y;
  const lenSq = dx * dx + dy * dy;
  const r2 = circle.r * circle.r;
  if (lenSq < 1e-12) {
    // Degenerate segment: the whole thing is the point `a`.
    return fx * fx + fy * fy <= r2 ? { a: 0, b: 1 } : null;
  }
  const bTerm = 2 * (fx * dx + fy * dy);
  const cTerm = fx * fx + fy * fy - r2;
  const disc = bTerm * bTerm - 4 * lenSq * cTerm;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  const t0 = Math.max(0, (-bTerm - sqrtDisc) / (2 * lenSq));
  const t1 = Math.min(1, (-bTerm + sqrtDisc) / (2 * lenSq));
  return t0 < t1 ? { a: t0, b: t1 } : null;
}

/** Merge overlapping/adjacent covered intervals into a sorted disjoint set. */
function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length <= 1) return intervals;
  const sorted = [...intervals].sort((x, y) => x.a - y.a);
  const merged: Interval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i += 1) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.a <= last.b + EPS) {
      last.b = Math.max(last.b, cur.b);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/** The complement of the covered intervals within [0, 1]. */
function survivingIntervals(covered: Interval[]): Interval[] {
  const merged = mergeIntervals(covered);
  const surviving: Interval[] = [];
  let cursor = 0;
  for (const interval of merged) {
    if (interval.a > cursor + EPS) surviving.push({ a: cursor, b: interval.a });
    cursor = Math.max(cursor, interval.b);
  }
  if (cursor < 1 - EPS) surviving.push({ a: cursor, b: 1 });
  return surviving;
}

export interface SliceResult {
  /** True when at least one part of the stroke was removed. */
  changed: boolean;
  /** Surviving pieces (each with ≥ 2 points). Empty if fully erased. */
  fragments: InkPoint[][];
}

/**
 * Split `points` into the fragments that remain after erasing everything
 * covered by `circles`. When nothing is touched, `changed` is false and
 * `fragments` holds the original polyline unchanged.
 */
export function sliceStrokeByCircles(
  points: InkPoint[],
  circles: EraserCircle[]
): SliceResult {
  if (points.length < 2 || circles.length === 0) {
    return { changed: false, fragments: [points] };
  }

  let changed = false;
  const fragments: InkPoint[][] = [];
  let current: InkPoint[] = [];
  const flush = () => {
    if (current.length >= 2) fragments.push(current);
    current = [];
  };

  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const covered: Interval[] = [];
    for (const circle of circles) {
      const interval = segmentInsideCircle(a, b, circle);
      if (interval) covered.push(interval);
    }

    if (covered.length === 0) {
      // Whole segment survives — extend the running fragment.
      if (current.length === 0) current.push(a);
      current.push(b);
      continue;
    }

    changed = true;
    const surviving = survivingIntervals(covered);
    for (const interval of surviving) {
      const startsAtVertex = interval.a <= EPS;
      const endsAtVertex = interval.b >= 1 - EPS;
      const endPt = endsAtVertex ? b : lerpPoint(a, b, interval.b);
      if (startsAtVertex && current.length > 0) {
        // Continues from the previous segment across the shared vertex `a`.
        current.push(endPt);
      } else {
        flush();
        current = [startsAtVertex ? a : lerpPoint(a, b, interval.a), endPt];
      }
      // A piece that stops before the vertex leaves an erased gap after it.
      if (!endsAtVertex) flush();
    }
  }
  flush();

  if (!changed) return { changed: false, fragments: [points] };
  return { changed: true, fragments };
}
