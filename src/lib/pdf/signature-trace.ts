/**
 * Photo → vector signature tracing.
 *
 * Pure functions over plain typed arrays — no canvas / DOM dependency —
 * so the pipeline is unit-testable and shared verbatim by both entry
 * points (camera capture and image file import), which differ only in
 * how they produce the input raster (see signature-import-image.ts).
 *
 * Pipeline: RGBA raster → ink signal (min channel, so coloured pens
 * keep contrast) → local-mean adaptive threshold with hysteresis
 * (immune to lighting gradients; user-adjustable sensitivity; edge
 * pixels join at half the contrast when connected to confident ink) →
 * speck removal → Zhang-Suen
 * thinning → skeleton walk into polylines → Douglas-Peucker
 * simplification → uniform fit into the signature pad's coordinate
 * space. The output is the same stroke geometry the drawing pad
 * produces, so everything downstream (picker previews, placement, PDF
 * /Ink export, sync) works unchanged.
 */

import type { PdfInkStroke, PdfStrokePoint } from './types';

/* --- Shared pad-space constants -------------------------------------------- */

// Same canvas the drawing pad uses (SignaturePadDialog) so imported and
// hand-drawn signatures are interchangeable everywhere downstream.
export const SIGNATURE_PAD_WIDTH = 420;
export const SIGNATURE_PAD_HEIGHT = 168;
export const SIGNATURE_STROKE_COLOR = '#111827';
export const SIGNATURE_STROKE_WIDTH = 3.5;

/** Breathing room inside the pad box when fitting traced strokes/images. */
export const SIGNATURE_PAD_MARGIN = 10;

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
   * Ink pickup sensitivity, 0–1 (default 0.5). Sets how much darker
   * than its local surroundings a pixel must be to count as ink: low
   * values keep only bold, high-contrast strokes; high values pick up
   * faint pencil and pale ballpoint. The UI slider feeds this back in
   * when the user overrides the default.
   */
  sensitivity?: number;
  /**
   * Connected components smaller than this many pixels are treated as
   * dust / paper grain and dropped. Defaults to a size relative to the
   * image area.
   */
  minComponentSize?: number;
  /** Douglas-Peucker tolerance in source-image pixels. */
  simplifyTolerance?: number;
  /**
   * Ink components touching the frame border are dropped when thicker
   * than this (max inscribed L∞ radius, px) — fingers holding the
   * paper, table edges. Pen strokes stay far below any sane value.
   * Defaults relative to image size; pass 0 to disable.
   */
  borderBlobThickness?: number;
}

export interface TracedSignature {
  /** Pad-space geometry, ready to become a `PdfSignatureSnapshot`. */
  width: number;
  height: number;
  strokes: PdfInkStroke[];
  /** The sensitivity actually applied — seeds the UI slider. */
  sensitivity: number;
}

export interface SignatureMask {
  mask: BinaryMask;
  sensitivity: number;
}

/* --- Step 1: ink signal ------------------------------------------------------ */

/**
 * Per-pixel luminance 0–255, with alpha composited over white (photos
 * are opaque, but pasted PNGs may not be). Used by paper detection.
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

/**
 * Per-pixel ink signal 0–255: the *minimum* colour channel, alpha
 * composited over white. Coloured inks are dark in at least one channel
 * — blue ballpoint is bright in B but very dark in R — so the minimum
 * gives far better ink/paper contrast than luminance (which weights G
 * heavily and washes blue ink out), while paper stays bright in all
 * three channels and black ink is unaffected.
 */
export function inkSignal(image: RasterImage): Uint8Array {
  const { data } = image;
  const out = new Uint8Array(image.width * image.height);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    const a = data[o + 3] / 255;
    const min = Math.min(data[o], data[o + 1], data[o + 2]);
    out[i] = Math.round(min * a + 255 * (1 - a));
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

/* --- Step 3: adaptive binarize -------------------------------------------------- */

/**
 * Contrast a pixel must show against its local mean to count as ink,
 * derived from the sensitivity knob: sensitivity 0 → 30% darker
 * (only bold strokes), 0.5 → 16%, 1 → 2% (faint pencil).
 */
function requiredContrast(sensitivity: number): number {
  const s = Math.min(1, Math.max(0, sensitivity));
  return 0.3 - 0.28 * s;
}

/**
 * Hysteresis: a pixel connected to already-accepted ink only needs this
 * fraction of the full contrast. Stroke edges are photographed as
 * ink/paper blends that hover just under the strong cutoff — accepting
 * them when (and only when) they touch confident ink fills the choppy
 * boundary without letting isolated paper noise in.
 */
const WEAK_CONTRAST_RATIO = 0.5;

/**
 * Per-pixel mean of the surrounding window (the local paper-brightness
 * estimate the adaptive threshold and the edge alpha both compare
 * against), computed in O(n) via an integral image.
 */
export function localMeans(
  signal: Uint8Array,
  width: number,
  height: number
): Float32Array {
  // Half-window; full window ≈ min dimension / 6, comfortably wider
  // than any pen stroke at trace resolution.
  const half = Math.max(12, Math.round(Math.min(width, height) / 12));

  // Integral image with a zero row/column of padding.
  const iw = width + 1;
  const integral = new Float64Array(iw * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += signal[y * width + x];
      integral[(y + 1) * iw + (x + 1)] = integral[y * iw + (x + 1)] + rowSum;
    }
  }

  const means = new Float32Array(signal.length);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(height - 1, y + half);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(width - 1, x + half);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[(y1 + 1) * iw + (x1 + 1)] -
        integral[y0 * iw + (x1 + 1)] -
        integral[(y1 + 1) * iw + x0] +
        integral[y0 * iw + x0];
      means[y * width + x] = sum / area;
    }
  }
  return means;
}

/**
 * Local-mean adaptive ink mask with hysteresis: a pixel is ink when it
 * is at least `requiredContrast` darker than the mean of its
 * surrounding window, OR at least half that contrast darker while
 * 8-connected to accepted ink (Canny-style dual threshold). The strong
 * cutoff decides *which* marks are ink; the weak cutoff then grows each
 * mark into its blurred photographic edge, so stroke boundaries come
 * out smooth instead of choppy and faint mid-stroke segments stay
 * attached. Isolated weak pixels — paper grain, shadows — never reach a
 * strong seed and are dropped. Unlike a single global cutoff, the local
 * mean is immune to illumination gradients across the paper — the
 * classic badly-lit-room failure where any global threshold either eats
 * the shaded paper or drops the highlighted ink. The window is sized
 * well above the widest pen stroke so stroke interiors still see
 * mostly-paper surroundings and don't hollow out.
 *
 * Keeps the global path's polarity safeguard: if more than half the
 * frame reads as ink the mask is inverted — ink is always the minority.
 */
export function binarizeAdaptive(
  signal: Uint8Array,
  width: number,
  height: number,
  sensitivity: number
): BinaryMask {
  const strong = requiredContrast(sensitivity);
  const weak = strong * WEAK_CONTRAST_RATIO;
  const means = localMeans(signal, width, height);

  const data = new Uint8Array(signal.length);
  const stack: number[] = [];
  let ink = 0;
  for (let i = 0; i < signal.length; i++) {
    if (signal[i] < means[i] * (1 - strong)) {
      data[i] = 1;
      ink += 1;
      stack.push(i);
    }
  }
  // Flood from the strong seeds through weak-threshold pixels.
  while (stack.length) {
    const idx = stack.pop()!;
    const x = idx % width;
    const y = (idx - x) / width;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (data[nIdx]) continue;
      if (signal[nIdx] < means[nIdx] * (1 - weak)) {
        data[nIdx] = 1;
        ink += 1;
        stack.push(nIdx);
      }
    }
  }

  if (ink > signal.length / 2) {
    for (let i = 0; i < data.length; i++) data[i] ^= 1;
  }
  return { width, height, data };
}

/**
 * Antialiased per-pixel ink coverage (0–255) for rendering the mask as
 * a bitmap. A photographed stroke edge is physically a blend of ink and
 * paper, and the pixel's darkness encodes the blend ratio — so instead
 * of synthesising smoothness by blurring the binary mask, the alpha is
 * read off the signal itself: full opacity at the strong contrast
 * cutoff, fading linearly to zero at the local paper level. Only mask
 * pixels and their 1-px halo participate — everything else stays fully
 * transparent regardless of darkness (despeckled text, shadows), which
 * is safe because 8-connected components can't sit within 1 px of each
 * other without having been one component.
 */
export function computeInkAlpha(
  signal: Uint8Array,
  mask: BinaryMask,
  sensitivity: number
): Uint8Array {
  const { width, height, data } = mask;
  const strong = requiredContrast(sensitivity);
  const means = localMeans(signal, width, height);

  const alpha = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      let eligible = data[idx] === 1;
      if (!eligible) {
        for (const [dx, dy] of NEIGHBOURS) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (data[ny * width + nx]) {
            eligible = true;
            break;
          }
        }
      }
      if (!eligible) continue;
      const t0 = means[idx]; // alpha 0 at the local paper level
      const t1 = means[idx] * (1 - strong); // alpha 255 at the strong cutoff
      if (t0 - t1 < 1) {
        // Degenerate ramp (near-max sensitivity) → binary coverage.
        alpha[idx] = data[idx] ? 255 : 0;
      } else {
        const a = (t0 - signal[idx]) / (t0 - t1);
        alpha[idx] = Math.round(255 * Math.min(1, Math.max(0, a)));
      }
    }
  }
  return alpha;
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

/* --- Step 4b: border-object rejection ------------------------------------------ */

/**
 * Chessboard (L∞) distance of every ink pixel to the nearest background
 * pixel, two-pass. Out-of-frame counts as ink, so an object clipped by
 * the frame edge keeps its full measured thickness.
 */
export function distanceTransform(mask: BinaryMask): Uint16Array {
  const { width, height, data } = mask;
  const INF = 0xffff;
  const dist = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) dist[i] = data[i] ? INF : 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!dist[idx]) continue;
      let d = dist[idx];
      if (x > 0) d = Math.min(d, dist[idx - 1] + 1);
      if (y > 0) {
        d = Math.min(d, dist[idx - width] + 1);
        if (x > 0) d = Math.min(d, dist[idx - width - 1] + 1);
        if (x < width - 1) d = Math.min(d, dist[idx - width + 1] + 1);
      }
      dist[idx] = d;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const idx = y * width + x;
      if (!dist[idx]) continue;
      let d = dist[idx];
      if (x < width - 1) d = Math.min(d, dist[idx + 1] + 1);
      if (y < height - 1) {
        d = Math.min(d, dist[idx + width] + 1);
        if (x < width - 1) d = Math.min(d, dist[idx + width + 1] + 1);
        if (x > 0) d = Math.min(d, dist[idx + width - 1] + 1);
      }
      dist[idx] = d;
    }
  }
  return dist;
}

/**
 * Drop ink components that touch the frame border AND are thicker than
 * `maxThickness` (max inscribed L∞ radius). Pen strokes are thin
 * everywhere; fingers holding the paper, table edges, and other clutter
 * reaching in from outside are fat blobs — this removes them without
 * any appearance modelling, so it's independent of skin tone and
 * lighting. Interior blobs are never touched: only things that enter
 * from the frame edge qualify.
 */
export function removeBorderBlobs(
  mask: BinaryMask,
  maxThickness: number
): BinaryMask {
  const { width, height } = mask;
  const data = Uint8Array.from(mask.data);
  const dist = distanceTransform(mask);
  const seen = new Uint8Array(data.length);
  const stack: number[] = [];
  const component: number[] = [];

  for (let start = 0; start < data.length; start++) {
    if (!data[start] || seen[start]) continue;
    stack.length = 0;
    component.length = 0;
    stack.push(start);
    seen[start] = 1;
    let touchesBorder = false;
    let thickness = 0;
    while (stack.length) {
      const idx = stack.pop()!;
      component.push(idx);
      if (dist[idx] > thickness) thickness = dist[idx];
      const x = idx % width;
      const y = (idx - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        touchesBorder = true;
      }
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
    if (touchesBorder && thickness > maxThickness) {
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

/* --- Pipeline ------------------------------------------------------------------------ */

function defaultMinComponentSize(width: number, height: number): number {
  return Math.max(8, Math.round((width * height) / 20000));
}

// ~2% of the shorter side: at a 1000px trace a marker stroke's half-
// width is ~7px while a finger's is ~35px, so 20px separates them with
// margin on both sides.
function defaultBorderBlobThickness(width: number, height: number): number {
  return Math.max(6, Math.round(Math.min(width, height) * 0.02));
}

export function extractSignatureMask(
  image: RasterImage,
  options: TraceSignatureOptions = {}
): SignatureMask {
  const sensitivity = Math.min(1, Math.max(0, options.sensitivity ?? 0.5));
  const mask = binarizeAdaptive(
    inkSignal(image),
    image.width,
    image.height,
    sensitivity
  );
  const despeckled = removeSpecks(
    mask,
    options.minComponentSize ??
      defaultMinComponentSize(image.width, image.height)
  );
  const borderThickness =
    options.borderBlobThickness ??
    defaultBorderBlobThickness(image.width, image.height);
  return {
    mask:
      borderThickness > 0
        ? removeBorderBlobs(despeckled, borderThickness)
        : despeckled,
    sensitivity
  };
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
  const { mask: cleaned, sensitivity } = extractSignatureMask(image, options);
  const skeleton = thin(cleaned);
  const tolerance = options.simplifyTolerance ?? 1.2;
  // Widths are sampled on the pre-thinning mask while the points still
  // sit on skeleton pixels — simplification only drops points, so the
  // sampled widths survive it.
  const polylines = attachMeasuredWidths(traceSkeleton(skeleton), cleaned)
    .map((line) => simplifyPolyline(line, tolerance))
    .filter((line) => line.length >= 2);

  return {
    width: SIGNATURE_PAD_WIDTH,
    height: SIGNATURE_PAD_HEIGHT,
    strokes: fitToPad(polylines),
    sensitivity
  };
}
