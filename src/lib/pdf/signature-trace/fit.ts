/**
 * Steps 7b-8: giving the traced polylines width and pad coordinates.
 *
 * Width comes from measuring the original mask at each skeleton point
 * (via the distance transform), so a pen that varies pressure keeps that
 * variation. The fit is uniform and centred, so the signature's aspect
 * ratio survives the move into pad space.
 */

import type { PdfInkStroke, PdfStrokePoint } from '../types';
import type { BinaryMask } from './types';
import { distanceTransform } from './denoise';
import {
  SIGNATURE_PAD_HEIGHT,
  SIGNATURE_PAD_MARGIN,
  SIGNATURE_PAD_WIDTH,
  SIGNATURE_STROKE_COLOR,
  SIGNATURE_STROKE_WIDTH
} from './types';

/* --- Step 7b: measured stroke widths ----------------------------------------------- */

/** Clamp range for the pad-space stroke width derived from measurement. */
const MIN_TRACED_WIDTH = 1.2;
const MAX_TRACED_WIDTH = 10;
/** Per-point spread around the stroke's mean width kept after clamping. */
const MIN_RELATIVE_PRESSURE = 0.25;
const MAX_RELATIVE_PRESSURE = 2.5;

/**
 * Annotate each skeleton point with the measured ink width (in source
 * pixels) at that spot, carried in `pressure` until `fitToPad` converts
 * it. The width comes from the pre-thinning distance transform — the
 * L∞ radius to the nearest background pixel, i.e. the pen's local
 * half-width. A short moving average removes pixel-level jitter so the
 * rendered stroke swells and tapers smoothly.
 */
export function attachMeasuredWidths(
  polylines: PdfStrokePoint[][],
  inkMask: BinaryMask
): PdfStrokePoint[][] {
  const dist = distanceTransform(inkMask);
  const WINDOW = 2; // ±2 points → 5-point moving average
  return polylines.map((line) => {
    const raw = line.map((p) => {
      const d = dist[p.y * inkMask.width + p.x];
      return Math.max(1, 2 * d - 1);
    });
    return line.map((p, i) => {
      let sum = 0;
      let n = 0;
      for (let j = i - WINDOW; j <= i + WINDOW; j++) {
        if (j < 0 || j >= raw.length) continue;
        sum += raw[j];
        n += 1;
      }
      return { ...p, pressure: sum / n };
    });
  });
}

/* --- Step 8: fit into pad space --------------------------------------------------- */

/**
 * Uniformly scale + centre the polylines into the signature pad box.
 * Returns finished `PdfInkStroke`s.
 *
 * Width handling: when the incoming points carry `pressure`, it is read
 * as the measured ink width at that point in *source pixels* (see
 * attachMeasuredWidths). Each stroke then gets `width` = its mean
 * measured width mapped into pad units, and per-point `pressure`
 * relative to that mean (mean ≡ 1) — the convention the variable-width
 * renderer consumes (stroke-utils). Points without pressure fall back
 * to the pad's uniform styling, unchanged from hand-drawn strokes.
 */
export function fitToPad(polylines: PdfStrokePoint[][]): PdfInkStroke[] {
  if (polylines.length === 0) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const line of polylines) {
    for (const p of line) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  const srcW = Math.max(1e-6, maxX - minX);
  const srcH = Math.max(1e-6, maxY - minY);
  const boxW = SIGNATURE_PAD_WIDTH - SIGNATURE_PAD_MARGIN * 2;
  const boxH = SIGNATURE_PAD_HEIGHT - SIGNATURE_PAD_MARGIN * 2;
  const scale = Math.min(boxW / srcW, boxH / srcH);
  const offsetX = (SIGNATURE_PAD_WIDTH - srcW * scale) / 2;
  const offsetY = (SIGNATURE_PAD_HEIGHT - srcH * scale) / 2;

  return polylines.map((line) => {
    const widths = line.map((p) => p.pressure);
    const measured = widths.every((w) => typeof w === 'number' && w > 0);
    let strokeWidth = SIGNATURE_STROKE_WIDTH;
    let relative: number[] | null = null;
    if (measured) {
      const mean =
        (widths as number[]).reduce((s, w) => s + w, 0) / widths.length;
      strokeWidth = Math.min(
        MAX_TRACED_WIDTH,
        Math.max(MIN_TRACED_WIDTH, mean * scale)
      );
      relative = (widths as number[]).map((w) =>
        Math.min(
          MAX_RELATIVE_PRESSURE,
          Math.max(MIN_RELATIVE_PRESSURE, w / mean)
        )
      );
    }
    return {
      id: crypto.randomUUID(),
      color: SIGNATURE_STROKE_COLOR,
      width: strokeWidth,
      points: line.map((p, i) => ({
        x: (p.x - minX) * scale + offsetX,
        y: (p.y - minY) * scale + offsetY,
        pressure: relative ? relative[i] : 1
      }))
    };
  });
}
