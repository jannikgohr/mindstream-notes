/**
 * Pure logic behind rendering an extracted signature as a transparent
 * bitmap: crop bounds, colour parsing, RGBA pixel synthesis, and the
 * fit-into-pad placement. Split out of signature-import-image.ts so the
 * decisions stay unit-testable while that file keeps only the canvas
 * plumbing (contexts, ImageData, PNG encoding) the DOM has to do.
 */

import {
  SIGNATURE_PAD_HEIGHT,
  SIGNATURE_PAD_MARGIN,
  SIGNATURE_PAD_WIDTH
} from './signature-trace';

export interface InkBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bounding box of the non-zero entries of a mask or alpha plane. */
export function inkBounds(plane: Uint8Array, width: number): InkBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < plane.length; i++) {
    if (!plane[i]) continue;
    const x = i % width;
    const y = (i - x) / width;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/** #rrggbb → [r, g, b]; malformed input falls back to the ink colour. */
export function parseHexColor(hex: string): [number, number, number] {
  const v = hex.replace('#', '');
  if (v.length !== 6) return [17, 24, 39];
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    return [17, 24, 39];
  }
  return [r, g, b];
}

export interface InkPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Synthesise the cropped RGBA pixels for the ink: solid stroke colour
 * with the antialiased per-pixel coverage as alpha, fully transparent
 * elsewhere.
 */
export function renderInkPixels(
  alpha: Uint8Array,
  planeWidth: number,
  bounds: InkBounds,
  [r, g, b]: [number, number, number]
): InkPixels {
  const width = bounds.maxX - bounds.minX + 1;
  const height = bounds.maxY - bounds.minY + 1;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const coverage = alpha[(bounds.minY + y) * planeWidth + bounds.minX + x];
      if (!coverage) continue;
      const out = (y * width + x) * 4;
      data[out] = r;
      data[out + 1] = g;
      data[out + 2] = b;
      data[out + 3] = coverage;
    }
  }
  return { width, height, data };
}

export interface PadPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Uniformly scale a source rectangle into the signature pad box (with
 * margin) and centre it — the same fit hand-drawn strokes get.
 */
export function padPlacement(
  sourceWidth: number,
  sourceHeight: number
): PadPlacement {
  const scale = Math.min(
    (SIGNATURE_PAD_WIDTH - SIGNATURE_PAD_MARGIN * 2) / sourceWidth,
    (SIGNATURE_PAD_HEIGHT - SIGNATURE_PAD_MARGIN * 2) / sourceHeight
  );
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  return {
    x: Math.round((SIGNATURE_PAD_WIDTH - width) / 2),
    y: Math.round((SIGNATURE_PAD_HEIGHT - height) / 2),
    width,
    height
  };
}
