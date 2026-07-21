/**
 * Step 4: dropping everything that isn't signature.
 *
 * Three independent filters, because photographed paper produces three
 * distinct kinds of noise: isolated specks, blobs bleeding in from the
 * page edge (a finger, a shadow, the table), and components that are
 * technically ink but far fainter than the signature's core strokes.
 */

import { localMeans, requiredContrast } from './binarize';
import { NEIGHBOURS, type BinaryMask } from './types';

/**
 * Coverage floor for pixels the mask accepted as ink. Bridged gap
 * pixels and barely-weak edge pixels can be nearly paper-bright, and a
 * purely signal-derived alpha would render them invisible — leaving a
 * detected stroke looking broken. Any pixel the pipeline decided IS
 * ink stays at least faintly visible.
 */
const MIN_MASK_ALPHA = 64;

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
        const scaled = Math.round(255 * Math.min(1, Math.max(0, a)));
        alpha[idx] = data[idx] ? Math.max(MIN_MASK_ALPHA, scaled) : scaled;
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

/* --- Step 4c: relative-darkness filtering ---------------------------------------- */

/**
 * A component must reach this fraction of the frame's reference ink
 * darkness to survive. Real pen ink sits at 60–90% contrast against
 * paper while the grain/noise that clears a permissive threshold sits
 * at 2–8%, so the ratio has a wide safe band; 0.35 keeps genuinely
 * light strokes (same pen, lighter pressure) while still separating
 * noise from faint pencil.
 */
export const FAINT_COMPONENT_RATIO = 0.35;

/**
 * A component's darkness is the contrast of its darkest pixels — the
 * 85th percentile, not the median. Hysteresis grows every stroke a
 * soft low-contrast halo, and a thin stroke is mostly perimeter, so
 * halo pixels can outnumber its core; a median would read the whole
 * stroke as pale and delete it. The core percentile is immune to that
 * dilution while still ignoring the odd extra-dark outlier pixel, and
 * noise stays separable because a paper-grain speck has no dark core
 * at any percentile.
 */
const CORE_DARKNESS_PERCENTILE = 0.85;

/**
 * Drop components that are far *lighter* than the frame's actual ink.
 *
 * At high sensitivity the threshold accepts anything a few percent
 * darker than the local paper level, which lets paper grain, sensor
 * noise, and JPEG artifacts through as speckles — often grown past the
 * size-based despeckle limit by hysteresis. Size can't separate them
 * from an i-dot, but darkness can: each component's darkness is the
 * core contrast of its pixels against the local paper level (see
 * CORE_DARKNESS_PERCENTILE), and the frame's reference darkness is the
 * ink-pixel-weighted median of those (the signature holds most of the
 * ink pixels, so the reference is the signature's own ink level).
 * Components below `ratio` × reference are noise riding on a much
 * darker signature. A uniformly faint pencil signature IS the
 * reference — nothing is dropped when there is no darker ink to
 * compare against.
 */
export function removeFaintComponents(
  mask: BinaryMask,
  signal: Uint8Array,
  ratio: number = FAINT_COMPONENT_RATIO
): BinaryMask {
  const { width, height } = mask;
  const data = Uint8Array.from(mask.data);
  if (ratio <= 0) return { width, height, data };
  const means = localMeans(signal, width, height);
  const seen = new Uint8Array(data.length);
  const stack: number[] = [];
  const allContrasts: number[] = [];

  interface Component {
    pixels: number[];
    darkness: number;
  }
  const components: Component[] = [];

  for (let start = 0; start < data.length; start++) {
    if (!data[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    const pixels: number[] = [];
    while (stack.length) {
      const idx = stack.pop()!;
      pixels.push(idx);
      const x = idx % width;
      const y = (idx - x) / width;
      for (const [dx, dy] of NEIGHBOURS) {
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
    const contrasts = pixels.map((idx) => {
      const mean = means[idx];
      return mean > 0 ? Math.max(0, (mean - signal[idx]) / mean) : 0;
    });
    for (const c of contrasts) allContrasts.push(c);
    contrasts.sort((a, b) => a - b);
    const core = Math.min(
      contrasts.length - 1,
      Math.floor(contrasts.length * CORE_DARKNESS_PERCENTILE)
    );
    components.push({ pixels, darkness: contrasts[core] });
  }
  if (components.length === 0) return { width, height, data };

  // Reference = the 95th-percentile contrast over ALL ink pixels: what
  // "this frame's darkest real ink" looks like. Per-pixel rather than
  // per-component because at permissive thresholds noise pixels (and
  // even noise components, once grain clumps) can OUTNUMBER the
  // signature — any component-weighted average would land inside the
  // noise and bless all of it. The signature's core pixels are the
  // darkest population in the frame, so the top twentieth reads them
  // even when they are a small minority; a lone dark dust fleck is
  // too few pixels to move a percentile.
  allContrasts.sort((a, b) => a - b);
  const reference =
    allContrasts[
      Math.min(allContrasts.length - 1, Math.floor(allContrasts.length * 0.95))
    ];

  for (const c of components) {
    if (c.darkness < reference * ratio) {
      for (const idx of c.pixels) data[idx] = 0;
    }
  }
  return { width, height, data };
}

/* --- Step 5: Zhang-Suen thinning ---------------------------------------------- */
