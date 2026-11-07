/**
 * Zoom-aware smoothing for freshly drawn strokes.
 *
 * Pointer input is only as precise as the screen it is drawn on: a mouse
 * reports whole device pixels, and pens and fingers jitter by a fraction
 * of one. A stroke drawn zoomed out stores that error in page units, so
 * zooming in later magnifies it into visible stairs and wobble. The fix
 * has to be sized in device pixels at the zoom the stroke was drawn at,
 * not at the zoom it is later viewed at.
 *
 * The filter fits a small weighted parabola through the samples around
 * each point, measured along the stroke's length, and moves the point
 * onto it. Unlike a plain moving average, that does not shrink tight
 * curves such as a small "o". Both ends stay pinned, so the newest point
 * of a stroke being drawn is always exactly under the pointer and
 * smoothing adds no lag. Each point may move at most `maxShift`, which
 * keeps the committed stroke within a fraction of a pixel of what the
 * Android live-ink overlay painted from the raw samples, so the hand-over
 * does not visibly jump.
 */

import type { InkPoint } from './page';

export interface StrokeSmoothing {
  /** Half-length of the averaging window along the stroke, in page units. */
  radius: number;
  /** Furthest any point may move from where it was sampled, in page units. */
  maxShift: number;
}

/**
 * Filter strength per input type, in device pixels at the drawing zoom.
 * A mouse needs the widest window: its error is a whole-pixel grid, and
 * shallow lines turn that grid into long stairs. Its shift stays within
 * the ±0.5 px of rounding per axis, so it removes the grid and nothing
 * else. Pens are precise and only need their sensor jitter evened out.
 */
const DEVICE_PX: Record<string, { radius: number; maxShift: number }> = {
  mouse: { radius: 8, maxShift: 0.75 },
  touch: { radius: 6, maxShift: 1 },
  pen: { radius: 4, maxShift: 0.5 }
};

export const NO_SMOOTHING: StrokeSmoothing = { radius: 0, maxShift: 0 };

export function strokeSmoothing(
  pointerType: string,
  scale: number,
  devicePixelRatio: number
): StrokeSmoothing {
  const px = DEVICE_PX[pointerType] ?? DEVICE_PX.pen;
  const devicePxToPage = 1 / (scale * devicePixelRatio);
  if (!Number.isFinite(devicePxToPage) || devicePxToPage <= 0)
    return NO_SMOOTHING;
  return {
    radius: px.radius * devicePxToPage,
    maxShift: px.maxShift * devicePxToPage
  };
}

/**
 * Smooth a stroke's centreline. Pressure is left as sampled, so widths
 * keep matching the live overlay. Returns the input when there is
 * nothing to smooth.
 */
export function smoothStroke(
  points: InkPoint[],
  { radius, maxShift }: StrokeSmoothing
): InkPoint[] {
  const n = points.length;
  if (n < 3 || !(radius > 0) || !(maxShift > 0)) return points;
  const along = new Float64Array(n);
  for (let i = 1; i < n; i += 1) {
    along[i] =
      along[i - 1] +
      Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  const length = along[n - 1];
  const out: InkPoint[] = new Array(n);
  // Shrinking the window symmetrically near the ends keeps the fit
  // centred, so the ends neither hook nor pull back. Both window edges
  // only ever move forward, so two cursors cover the whole stroke.
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i += 1) {
    const point = points[i];
    const window = Math.min(radius, along[i], length - along[i]);
    if (!(window > 0)) {
      out[i] = point;
      continue;
    }
    while (along[lo] < along[i] - window) lo += 1;
    while (hi + 1 < n && along[hi + 1] <= along[i] + window) hi += 1;
    // Weighted least squares for p(u) ≈ a + b·u + c·u² around this point,
    // with offsets relative to it; only `a`, the fit at u = 0, is needed.
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    let s4 = 0;
    let x0 = 0;
    let x1 = 0;
    let x2 = 0;
    let y0 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let j = lo; j <= hi; j += 1) {
      const u = (along[j] - along[i]) / window;
      const weight = 1 - u * u;
      if (weight <= 0) continue;
      const wu = weight * u;
      const wu2 = wu * u;
      const px = points[j].x - point.x;
      const py = points[j].y - point.y;
      s0 += weight;
      s1 += wu;
      s2 += wu2;
      s3 += wu2 * u;
      s4 += wu2 * u * u;
      x0 += weight * px;
      x1 += wu * px;
      x2 += wu2 * px;
      y0 += weight * py;
      y1 += wu * py;
      y2 += wu2 * py;
    }
    if (s0 <= 0) {
      out[i] = point;
      continue;
    }
    const m0 = s2 * s4 - s3 * s3;
    const m1 = s1 * s4 - s3 * s2;
    const m2 = s1 * s3 - s2 * s2;
    const det = s0 * m0 - s1 * m1 + s2 * m2;
    let dx: number;
    let dy: number;
    if (Math.abs(det) > 1e-9 * s0 * s0 * s0) {
      dx =
        (x0 * m0 - s1 * (x1 * s4 - s3 * x2) + s2 * (x1 * s3 - s2 * x2)) / det;
      dy =
        (y0 * m0 - s1 * (y1 * s4 - s3 * y2) + s2 * (y1 * s3 - s2 * y2)) / det;
    } else {
      // Too few distinct samples for a parabola: fall back to their mean.
      dx = x0 / s0;
      dy = y0 / s0;
    }
    const shift = Math.hypot(dx, dy);
    if (shift > maxShift) {
      dx *= maxShift / shift;
      dy *= maxShift / shift;
    }
    out[i] = { x: point.x + dx, y: point.y + dy, pressure: point.pressure };
  }
  return out;
}
