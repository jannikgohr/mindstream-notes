/**
 * Steps 1-3: raster → ink mask.
 *
 * The ink signal is the per-pixel minimum channel, so a blue or red pen
 * keeps its contrast against white paper. Thresholding is local-mean
 * adaptive with hysteresis rather than global, which is what makes the
 * pipeline survive a photo lit unevenly across the page.
 */

import { NEIGHBOURS, type BinaryMask, type RasterImage } from './types';

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
export function requiredContrast(sensitivity: number): number {
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
 * Ink pixels within this L∞ distance of each other get the gap between
 * them filled (see bridgeSmallGaps). A thin fast stroke photographs as
 * a dotted line — ink islands split by 1–2 px of near-paper — and
 * 8-connected growth stops at every gap, leaving the stroke
 * fragmented. Distance 3 chains across those dots while staying far
 * too short-ranged to connect separate letters.
 */
const BRIDGE_MAX_DISTANCE = 3;

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
 * Fill 1–2 px paper gaps between nearby ink pixels: for every pair of
 * ink pixels within BRIDGE_MAX_DISTANCE (L∞) of each other, the line
 * between them becomes ink. A thin fast stroke photographs as a dotted
 * line of ink islands; thresholding keeps the islands but the stroke
 * stays fragmented — visually broken and traced as many stub
 * polylines. Purely geometric on the already-thresholded mask, so
 * unlike growing the hysteresis reach it cannot crawl through
 * sub-threshold paper grain. Runs before despeckling so re-connected
 * fragments are judged (size, darkness) as the one stroke they are.
 */
export function bridgeSmallGaps(
  mask: BinaryMask,
  maxDistance: number = BRIDGE_MAX_DISTANCE
): BinaryMask {
  const { width, height } = mask;
  const data = Uint8Array.from(mask.data);
  const fills: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask.data[y * width + x]) continue;
      // Forward half of the neighbourhood only — pairs are symmetric.
      for (let dy = 0; dy <= maxDistance; dy++) {
        for (let dx = dy === 0 ? 2 : -maxDistance; dx <= maxDistance; dx++) {
          const steps = Math.max(Math.abs(dx), Math.abs(dy));
          if (steps < 2) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (!mask.data[ny * width + nx]) continue;
          for (let t = 1; t < steps; t++) {
            const fx = x + Math.round((dx * t) / steps);
            const fy = y + Math.round((dy * t) / steps);
            fills.push(fy * width + fx);
          }
        }
      }
    }
  }
  for (const idx of fills) data[idx] = 1;
  return { width, height, data };
}
