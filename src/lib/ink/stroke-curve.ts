/**
 * The curve a stroke is drawn as, shared by the canvas painter and the
 * PDF export so both draw the same shape.
 *
 * The curve runs straight from the first point to the first segment's
 * midpoint, then as a quadratic through each inner point to the next
 * midpoint, and straight into the last point. Passing through midpoints
 * keeps it tangent-continuous: dense input stays within a hair of the
 * polyline the Android live-ink overlay draws, while the corners between
 * sparse samples, which zooming in would expose, round off.
 */

import type { InkPoint } from './page';

/**
 * Receives the curve one piece at a time, in the stroke's own
 * coordinates. Each piece starts where the previous one ended (the first
 * at `points[0]`) and carries the pressure its width should follow.
 */
export interface StrokeCurveSink {
  line(x: number, y: number, pressure: number): void;
  quad(cx: number, cy: number, x: number, y: number, pressure: number): void;
}

export function traceStrokeCurve(
  points: InkPoint[],
  sink: StrokeCurveSink
): void {
  const n = points.length;
  if (n < 2) return;
  const first = points[0];
  const second = points[1];
  if (n === 2) {
    sink.line(second.x, second.y, (first.pressure + second.pressure) * 0.5);
    return;
  }
  sink.line(
    (first.x + second.x) * 0.5,
    (first.y + second.y) * 0.5,
    (first.pressure + second.pressure) * 0.5
  );
  for (let i = 1; i < n - 1; i += 1) {
    const before = points[i - 1];
    const point = points[i];
    const after = points[i + 1];
    sink.quad(
      point.x,
      point.y,
      (point.x + after.x) * 0.5,
      (point.y + after.y) * 0.5,
      // The mean of the two segments' pressures this piece spans halves of.
      (before.pressure + 2 * point.pressure + after.pressure) * 0.25
    );
  }
  const last = points[n - 1];
  sink.line(last.x, last.y, (points[n - 2].pressure + last.pressure) * 0.5);
}
