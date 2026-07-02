/**
 * Photo → vector signature tracing.
 *
 * Pure functions over plain typed arrays — no canvas / DOM dependency —
 * so the pipeline is unit-testable and shared verbatim by both entry
 * points (camera capture and image file import), which differ only in
 * how they produce the input raster (see signature-import-image.ts).
 *
 * Pipeline: RGBA raster → luminance → threshold (Otsu by default,
 * user-adjustable) → speck removal → Zhang-Suen thinning → skeleton
 * walk into polylines → Douglas-Peucker simplification → uniform fit
 * into the signature pad's coordinate space. The output is the same
 * stroke geometry the drawing pad produces, so everything downstream
 * (picker previews, placement, PDF /Ink export, sync) works unchanged.
 */

import type { PdfInkStroke, PdfStrokePoint } from './types';

/* --- Shared pad-space constants -------------------------------------------- */

// Same canvas the drawing pad uses (SignaturePadDialog) so imported and
// hand-drawn signatures are interchangeable everywhere downstream.
export const SIGNATURE_PAD_WIDTH = 420;
export const SIGNATURE_PAD_HEIGHT = 168;
export const SIGNATURE_STROKE_COLOR = '#111827';
export const SIGNATURE_STROKE_WIDTH = 3.5;

/** Breathing room inside the pad box when fitting traced strokes. */
const PAD_MARGIN = 10;

/* --- Types ------------------------------------------------------------------ */

/** RGBA pixels, 4 bytes per pixel, row-major — the layout of ImageData. */
export interface RasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** 1 = ink, 0 = background, row-major. */
export interface BinaryMask {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface TraceSignatureOptions {
  /**
   * Luminance cutoff 0–255; pixels darker than this count as ink.
   * Defaults to Otsu's automatic threshold. The UI slider feeds this
   * back in when the user overrides the automatic pick.
   */
  threshold?: number;
  /**
   * Connected components smaller than this many pixels are treated as
   * dust / paper grain and dropped. Defaults to a size relative to the
   * image area.
   */
  minComponentSize?: number;
  /** Douglas-Peucker tolerance in source-image pixels. */
  simplifyTolerance?: number;
}

export interface TracedSignature {
  /** Pad-space geometry, ready to become a `PdfSignatureSnapshot`. */
  width: number;
  height: number;
  strokes: PdfInkStroke[];
  /** The threshold actually applied — seeds the UI slider. */
  threshold: number;
}

/* --- Step 1: luminance ------------------------------------------------------ */

/**
 * Per-pixel luminance 0–255, with alpha composited over white (photos
 * are opaque, but pasted PNGs may not be).
 */
export function luminance(image: RasterImage): Uint8Array {
  const { data } = image;
  const out = new Uint8Array(image.width * image.height);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    const a = data[o + 3] / 255;
    const r = data[o] * a + 255 * (1 - a);
    const g = data[o + 1] * a + 255 * (1 - a);
    const b = data[o + 2] * a + 255 * (1 - a);
    out[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return out;
}

/* --- Step 2: Otsu threshold ------------------------------------------------- */

/**
 * Classic Otsu: pick the cutoff that maximises between-class variance
 * of the luminance histogram. Returns 127 for degenerate (single-level)
 * images so callers always get a usable value.
 */
export function otsuThreshold(gray: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]] += 1;

  const total = gray.length;
  let sumAll = 0;
  for (let level = 0; level < 256; level++) sumAll += level * hist[level];

  let sumBelow = 0;
  let countBelow = 0;
  let bestVariance = -1;
  let best = 127;
  for (let level = 0; level < 256; level++) {
    countBelow += hist[level];
    if (countBelow === 0) continue;
    const countAbove = total - countBelow;
    if (countAbove === 0) break;
    sumBelow += level * hist[level];
    const meanBelow = sumBelow / countBelow;
    const meanAbove = (sumAll - sumBelow) / countAbove;
    const variance = countBelow * countAbove * (meanBelow - meanAbove) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = level;
    }
  }
  return best;
}

/* --- Step 3: binarize -------------------------------------------------------- */

/**
 * Ink mask: pixels at or below the threshold. If that selects more than
 * half the frame the photo is light-on-dark (or the threshold landed in
 * the paper), so invert — a signature is always the minority of pixels.
 */
export function binarize(
  gray: Uint8Array,
  width: number,
  height: number,
  threshold: number
): BinaryMask {
  const data = new Uint8Array(gray.length);
  let ink = 0;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] <= threshold) {
      data[i] = 1;
      ink += 1;
    }
  }
  if (ink > gray.length / 2) {
    for (let i = 0; i < data.length; i++) data[i] ^= 1;
  }
  return { width, height, data };
}

/* --- Step 4: speck removal --------------------------------------------------- */

/**
 * Drop 8-connected components smaller than `minSize` pixels. Mutates a
 * copy — the input mask is left untouched.
 */
export function removeSpecks(mask: BinaryMask, minSize: number): BinaryMask {
  const { width, height } = mask;
  const data = Uint8Array.from(mask.data);
  const seen = new Uint8Array(data.length);
  const stack: number[] = [];
  const component: number[] = [];

  for (let start = 0; start < data.length; start++) {
    if (!data[start] || seen[start]) continue;
    stack.length = 0;
    component.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const idx = stack.pop()!;
      component.push(idx);
      const x = idx % width;
      const y = (idx - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (data[nIdx] && !seen[nIdx]) {
            seen[nIdx] = 1;
            stack.push(nIdx);
          }
        }
      }
    }
    if (component.length < minSize) {
      for (const idx of component) data[idx] = 0;
    }
  }
  return { width, height, data };
}

/* --- Step 5: Zhang-Suen thinning ---------------------------------------------- */

/**
 * Iteratively erode the ink mask down to a 1-pixel-wide skeleton while
 * preserving connectivity (Zhang-Suen, 1984). Out-of-bounds neighbours
 * read as background.
 */
export function thin(mask: BinaryMask): BinaryMask {
  const { width, height } = mask;
  const data = Uint8Array.from(mask.data);
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : data[y * width + x];

  const toClear: number[] = [];
  // Each pass peels at most one pixel of thickness from each side, so
  // the stroke half-width bounds the iteration count; the cap is a
  // safety net, not a tuning knob.
  const maxIterations = Math.max(width, height);

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    for (let sub = 0; sub < 2; sub++) {
      toClear.length = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (!data[y * width + x]) continue;
          // Neighbours clockwise from north: P2..P9.
          const p2 = at(x, y - 1);
          const p3 = at(x + 1, y - 1);
          const p4 = at(x + 1, y);
          const p5 = at(x + 1, y + 1);
          const p6 = at(x, y + 1);
          const p7 = at(x - 1, y + 1);
          const p8 = at(x - 1, y);
          const p9 = at(x - 1, y - 1);
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let transitions = 0;
          for (let i = 0; i < 8; i++) {
            if (seq[i] === 0 && seq[i + 1] === 1) transitions += 1;
          }
          if (transitions !== 1) continue;
          if (sub === 0) {
            if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
          }
          toClear.push(y * width + x);
        }
      }
      for (const idx of toClear) data[idx] = 0;
      if (toClear.length > 0) changed = true;
    }
    if (!changed) break;
  }
  return { width, height, data };
}

/* --- Step 6: skeleton → polylines ---------------------------------------------- */

// 8-neighbour offsets, clockwise.
const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1]
];

/**
 * Walk the 1-px skeleton into polylines. Walks start at endpoints
 * (single-neighbour pixels) and continue as long as an unvisited
 * neighbour exists, preferring the neighbour that best continues the
 * current direction — so a stroke that crosses itself is traced as one
 * long pen movement instead of being chopped at the junction. Closed
 * loops (no endpoints, e.g. an "o") are picked up in a second pass.
 */
export function traceSkeleton(mask: BinaryMask): PdfStrokePoint[][] {
  const { width, height, data } = mask;
  const visited = new Uint8Array(data.length);

  const neighboursOf = (idx: number): number[] => {
    const x = idx % width;
    const y = (idx - x) / width;
    const out: number[] = [];
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (data[nIdx]) out.push(nIdx);
    }
    return out;
  };

  const walk = (start: number): PdfStrokePoint[] => {
    const path: number[] = [start];
    visited[start] = 1;
    let prev = -1;
    let current = start;
    for (;;) {
      const candidates = neighboursOf(current).filter((idx) => !visited[idx]);
      if (candidates.length === 0) break;
      let next = candidates[0];
      if (prev !== -1 && candidates.length > 1) {
        // Prefer the straightest continuation (largest cosine between
        // the incoming and outgoing step vectors).
        const cx = current % width;
        const cy = (current - cx) / width;
        const px = prev % width;
        const py = (prev - px) / width;
        const inX = cx - px;
        const inY = cy - py;
        let bestDot = -Infinity;
        for (const cand of candidates) {
          const nx = cand % width;
          const ny = (cand - nx) / width;
          const outX = nx - cx;
          const outY = ny - cy;
          const dot =
            (inX * outX + inY * outY) /
            (Math.hypot(inX, inY) * Math.hypot(outX, outY));
          if (dot > bestDot) {
            bestDot = dot;
            next = cand;
          }
        }
      }
      path.push(next);
      visited[next] = 1;
      prev = current;
      current = next;
    }
    return path.map((idx) => {
      const x = idx % width;
      return { x, y: (idx - x) / width };
    });
  };

  const polylines: PdfStrokePoint[][] = [];

  // Pass 1: open strokes, walked from their endpoints.
  for (let idx = 0; idx < data.length; idx++) {
    if (!data[idx] || visited[idx]) continue;
    if (neighboursOf(idx).length !== 1) continue;
    polylines.push(walk(idx));
  }

  // Pass 2: whatever remains is loops (or junction leftovers). Isolated
  // single pixels are dropped — after despeckling they're noise.
  for (let idx = 0; idx < data.length; idx++) {
    if (!data[idx] || visited[idx]) continue;
    if (neighboursOf(idx).length === 0) {
      visited[idx] = 1;
      continue;
    }
    const loop = walk(idx);
    // Close the ring visually when the walk ended adjacent to its start.
    if (loop.length > 2) {
      const first = loop[0];
      const last = loop[loop.length - 1];
      if (Math.abs(first.x - last.x) <= 1 && Math.abs(first.y - last.y) <= 1) {
        loop.push({ ...first });
      }
    }
    polylines.push(loop);
  }

  return polylines.filter((line) => line.length >= 2);
}

/* --- Step 7: simplification ----------------------------------------------------- */

/** Iterative Ramer-Douglas-Peucker. Keeps endpoints, drops points whose
 *  perpendicular distance to the chord is within `tolerance`. */
export function simplifyPolyline(
  points: PdfStrokePoint[],
  tolerance: number
): PdfStrokePoint[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop()!;
    const a = points[from];
    const b = points[to];
    const abX = b.x - a.x;
    const abY = b.y - a.y;
    const abLen = Math.hypot(abX, abY);
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = from + 1; i < to; i++) {
      const p = points[i];
      const dist =
        abLen === 0
          ? Math.hypot(p.x - a.x, p.y - a.y)
          : Math.abs(abX * (a.y - p.y) - (a.x - p.x) * abY) / abLen;
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }
    if (maxDist > tolerance && maxIdx !== -1) {
      keep[maxIdx] = 1;
      stack.push([from, maxIdx], [maxIdx, to]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/* --- Step 8: fit into pad space --------------------------------------------------- */

/**
 * Uniformly scale + centre the polylines into the signature pad box.
 * Returns finished `PdfInkStroke`s with the pad's stroke styling.
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
  const boxW = SIGNATURE_PAD_WIDTH - PAD_MARGIN * 2;
  const boxH = SIGNATURE_PAD_HEIGHT - PAD_MARGIN * 2;
  const scale = Math.min(boxW / srcW, boxH / srcH);
  const offsetX = (SIGNATURE_PAD_WIDTH - srcW * scale) / 2;
  const offsetY = (SIGNATURE_PAD_HEIGHT - srcH * scale) / 2;

  return polylines.map((line) => ({
    id: crypto.randomUUID(),
    color: SIGNATURE_STROKE_COLOR,
    width: SIGNATURE_STROKE_WIDTH,
    points: line.map((p) => ({
      x: (p.x - minX) * scale + offsetX,
      y: (p.y - minY) * scale + offsetY,
      pressure: 1
    }))
  }));
}

/* --- Pipeline ------------------------------------------------------------------------ */

function defaultMinComponentSize(width: number, height: number): number {
  return Math.max(8, Math.round((width * height) / 20000));
}

/**
 * Run the whole pipeline. `strokes` is empty when no ink survives
 * thresholding + despeckling (blank page, threshold too aggressive) —
 * callers surface that instead of saving an empty signature.
 */
export function traceSignature(
  image: RasterImage,
  options: TraceSignatureOptions = {}
): TracedSignature {
  const gray = luminance(image);
  const threshold = options.threshold ?? otsuThreshold(gray);
  const mask = binarize(gray, image.width, image.height, threshold);
  const cleaned = removeSpecks(
    mask,
    options.minComponentSize ??
      defaultMinComponentSize(image.width, image.height)
  );
  const skeleton = thin(cleaned);
  const tolerance = options.simplifyTolerance ?? 1.2;
  const polylines = traceSkeleton(skeleton)
    .map((line) => simplifyPolyline(line, tolerance))
    .filter((line) => line.length >= 2);

  return {
    width: SIGNATURE_PAD_WIDTH,
    height: SIGNATURE_PAD_HEIGHT,
    strokes: fitToPad(polylines),
    threshold
  };
}
