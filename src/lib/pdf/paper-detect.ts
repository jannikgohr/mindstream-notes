/**
 * Paper detection + perspective rectification for the signature import.
 *
 * Finds the sheet of paper in a photo and warps it fronto-parallel so
 * the tracing pipeline gets the full resolution budget on the paper
 * instead of the room. Pure data-in/data-out like signature-trace.ts —
 * image-js supplies the heavy lifting (Otsu mask, connected regions,
 * convex hull, blur, 4-point perspective warp) and runs without any
 * DOM, so this module is fully unit-testable.
 *
 * Two candidate detectors run, and a shared perimeter-support score
 * arbitrates:
 *
 * 1. REGION: paper is *bright and achromatic*. The strict pass masks
 *    pixels that clear the Otsu brightness split AND have low colour
 *    saturation — that split is what keeps a hand holding the paper out
 *    of the region: skin of any tone is strongly chromatic while white
 *    paper is not, so this needs no skin model and is exposure-robust.
 *    Coloured paper fails the strict pass, so a brightness-only
 *    fallback pass preserves the old behaviour for it. The largest
 *    region's convex hull gets the maximum-area quadrilateral fitted;
 *    the hull bridges over occlusions (a finger biting a concavity into
 *    the edge). Fast and precise — but blind when the paper lies on an
 *    equally bright surface (white desk), where the Otsu split follows
 *    the room lighting instead of the paper.
 *
 * 2. EDGES: gradient + Hough transform. Paper boundaries photograph as
 *    long straight brightness steps even in white-on-white scenes (the
 *    sheet casts a hairline shadow), so dominant lines are recovered
 *    from a gradient-aligned Hough vote and assembled into candidate
 *    quads. Votes are unweighted — a long faint edge must outvote
 *    short dark ink strokes.
 *
 * Every candidate is scored by how much of its perimeter lies on real,
 * correctly-oriented image edges, minus a penalty for long supported
 * lines strictly inside the quad (a quad that swallowed the true paper
 * edge — e.g. one built from a shadow boundary — contains it as an
 * unexplained interior line). This one score kills lighting-region
 * quads (their frame-border sides have no edge support), arbitrates
 * region vs edge candidates, and rejects everything when the scene has
 * no convincing paper — `detectPaperQuad` then returns null and
 * callers fall back to the whole-frame behaviour.
 */

import { Image, Mask, fromMask, getPerspectiveWarp } from 'image-js';
import { luminance, otsuThreshold } from './signature-trace';
import type { RasterImage } from './signature-trace';

export interface QuadPoint {
  x: number;
  y: number;
}

/** Paper corners in source-image pixels, ordered TL, TR, BR, BL. */
export type PaperQuad = [QuadPoint, QuadPoint, QuadPoint, QuadPoint];

export interface DetectPaperOptions {
  /** Width the image is downscaled to before detection. */
  workingWidth?: number;
  /** Reject bright regions smaller than this fraction of the frame. */
  minAreaFraction?: number;
  /** Reject regions that basically fill the frame — nothing to crop. */
  maxAreaFraction?: number;
  /** Reject regions whose shape is not paper-like (area / hull area). */
  minSolidity?: number;
  /**
   * Saturation ceiling for the strict "achromatic paper" pass, 0–1
   * (chroma / max channel). Warm indoor light tints white paper to
   * ~0.15–0.22; skin sits at ~0.35+.
   */
  maxSaturation?: number;
}

export interface RectifyPaperOptions {
  /**
   * Fraction each corner is pulled toward the quad centre before the
   * warp. Shaves paper-edge shadows and fingertip edges off the crop.
   */
  inset?: number;
  /** Cap on the longer output side. */
  maxDim?: number;
}

const DEFAULT_WORKING_WIDTH = 320;
const DEFAULT_MIN_AREA_FRACTION = 0.15;
const DEFAULT_MAX_AREA_FRACTION = 0.95;
// Loose enough that a hand occluding a corner (excluded from the region
// by the saturation mask, bridged by the hull) still passes, while
// genuinely non-quadrilateral shapes (an L is ~0.5) are rejected.
const DEFAULT_MIN_SOLIDITY = 0.72;
const DEFAULT_MAX_SATURATION = 0.28;
const DEFAULT_INSET = 0.03;
const DEFAULT_RECTIFY_MAX_DIM = 1200;

/** Cap on hull vertices fed to the O(n⁴) max-area quad search. */
const MAX_HULL_POINTS = 48;

/* --- Edge-path tuning ---------------------------------------------------------- */

/** Blur before the gradient: kills paper grain, keeps edges. */
const EDGE_BLUR_SIGMA = 1.5;
/** A pixel votes in the Hough accumulator above this magnitude percentile. */
const EDGE_MAG_PERCENTILE = 0.85;
/** Perimeter support counts edges above this (lower) percentile. */
const SUPPORT_MAG_PERCENTILE = 0.7;
/** Hough peaks kept for quad assembly. Faint real edges (white paper
 *  on a white desk) can rank well below shadow and texture lines, so
 *  the list is deliberately generous; scoring sorts the pretenders
 *  out. */
const MAX_HOUGH_LINES = 16;
/** Every quad side must lie on real edges for at least this fraction. */
const MIN_SIDE_SUPPORT = 0.3;
/** Candidates scoring below this are not paper. */
const MIN_QUAD_SCORE = 0.15;
/** A region-path score this good skips the Hough pass entirely. */
const REGION_SCORE_SHORTCUT = 0.35;

/* --- image-js interop -------------------------------------------------------- */

function toIjsImage(raster: RasterImage): Image {
  return new Image(raster.width, raster.height, {
    data: new Uint8Array(
      raster.data.buffer,
      raster.data.byteOffset,
      raster.data.length
    ),
    colorModel: 'RGBA'
  });
}

function toRaster(image: Image): RasterImage {
  const raw = image.getRawImage();
  return {
    width: raw.width,
    height: raw.height,
    data: new Uint8ClampedArray(raw.data)
  };
}

/** Downscale so the longer side is at most `maxDim` (no-op if smaller). */
export function downscaleRaster(
  raster: RasterImage,
  maxDim: number
): RasterImage {
  if (Math.max(raster.width, raster.height) <= maxDim) return raster;
  const img = toIjsImage(raster);
  const resized =
    raster.width >= raster.height
      ? img.resize({ width: maxDim })
      : img.resize({ height: maxDim });
  return toRaster(resized);
}

/* --- Geometry helpers --------------------------------------------------------- */

/** Shoelace area of a polygon whose vertices are in cyclic order. */
export function polygonArea(points: QuadPoint[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/**
 * Canonical corner order: sort cyclically around the centroid, then
 * rotate so the corner nearest the top-left comes first. Angle sorting
 * (rather than min/max coordinate picking) stays a valid cyclic order
 * for any rotation of the paper.
 */
export function orderQuad(points: QuadPoint[]): PaperQuad {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  const sorted = [...points].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
  );
  let tlIndex = 0;
  let tlScore = Infinity;
  for (let i = 0; i < sorted.length; i++) {
    const score = sorted[i].x + sorted[i].y;
    if (score < tlScore) {
      tlScore = score;
      tlIndex = i;
    }
  }
  return [
    sorted[tlIndex],
    sorted[(tlIndex + 1) % 4],
    sorted[(tlIndex + 2) % 4],
    sorted[(tlIndex + 3) % 4]
  ] as PaperQuad;
}

/**
 * Maximum-area quadrilateral over the (cyclically ordered) hull points.
 * Brute force over 4-subsets — the hull is pruned to at most
 * MAX_HULL_POINTS vertices, which keeps this well under a million
 * shoelace evaluations.
 */
export function maxAreaQuad(hull: QuadPoint[]): PaperQuad | null {
  if (hull.length < 4) return null;
  let pts = hull;
  if (pts.length > MAX_HULL_POINTS) {
    const step = pts.length / MAX_HULL_POINTS;
    pts = Array.from(
      { length: MAX_HULL_POINTS },
      (_, i) => hull[Math.floor(i * step)]
    );
  }
  const n = pts.length;
  let best: PaperQuad | null = null;
  let bestArea = 0;
  for (let i = 0; i < n - 3; i++) {
    for (let j = i + 1; j < n - 2; j++) {
      for (let k = j + 1; k < n - 1; k++) {
        for (let l = k + 1; l < n; l++) {
          const area = polygonArea([pts[i], pts[j], pts[k], pts[l]]);
          if (area > bestArea) {
            bestArea = area;
            best = [pts[i], pts[j], pts[k], pts[l]];
          }
        }
      }
    }
  }
  return best ? orderQuad(best) : null;
}

/* --- Detection ------------------------------------------------------------------ */

interface QuadSearchLimits {
  minAreaFraction: number;
  maxAreaFraction: number;
  minSolidity: number;
}

/**
 * Largest region of `maskData` → convex hull → max-area quad, with the
 * paper-plausibility checks. Working-scale coordinates.
 */
function quadFromMask(
  maskData: Uint8Array,
  width: number,
  height: number,
  limits: QuadSearchLimits
): PaperQuad | null {
  const rois = fromMask(new Mask(width, height, { data: maskData })).getRois({
    kind: 'white'
  });
  if (rois.length === 0) return null;

  let roi = rois[0];
  for (const candidate of rois) {
    if (candidate.surface > roi.surface) roi = candidate;
  }

  const frameArea = width * height;
  if (roi.surface < limits.minAreaFraction * frameArea) return null;
  if (roi.surface > limits.maxAreaFraction * frameArea) return null;

  // Hull points come back relative to the ROI's bounding box.
  const hull: QuadPoint[] = roi.convexHull.points.map((p) => ({
    x: p.column + roi.origin.column,
    y: p.row + roi.origin.row
  }));
  const hullArea = polygonArea(hull);
  if (hullArea <= 0) return null;
  if (roi.surface / hullArea < limits.minSolidity) return null;

  const quad = maxAreaQuad(hull);
  if (!quad) return null;
  // The quad must explain the hull — a degenerate fit means the region
  // wasn't quadrilateral to begin with.
  if (polygonArea(quad) < 0.8 * hullArea) return null;

  return quad;
}

/* --- Edge path: gradient, Hough lines, quad assembly ------------------------------ */

interface GradientField {
  width: number;
  height: number;
  /** Sobel magnitude per pixel (border row/column left at 0). */
  mag: Float32Array;
  /** Gradient direction per pixel, radians. */
  dir: Float32Array;
  /** Vote threshold (EDGE_MAG_PERCENTILE). */
  voteCut: number;
  /** Support threshold (SUPPORT_MAG_PERCENTILE). */
  supportCut: number;
}

function computeGradient(
  gray: Uint8Array,
  width: number,
  height: number
): GradientField {
  const mag = new Float32Array(width * height);
  const dir = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        -gray[i - width - 1] -
        2 * gray[i - 1] -
        gray[i + width - 1] +
        gray[i - width + 1] +
        2 * gray[i + 1] +
        gray[i + width + 1];
      const gy =
        -gray[i - width - 1] -
        2 * gray[i - width] -
        gray[i - width + 1] +
        gray[i + width - 1] +
        2 * gray[i + width] +
        gray[i + width + 1];
      mag[i] = Math.hypot(gx, gy);
      dir[i] = Math.atan2(gy, gx);
    }
  }
  const sorted = Float32Array.from(mag).sort();
  const pct = (p: number) => sorted[Math.floor(sorted.length * p)];
  return {
    width,
    height,
    mag,
    dir,
    voteCut: Math.max(6, pct(EDGE_MAG_PERCENTILE)),
    supportCut: Math.max(4, pct(SUPPORT_MAG_PERCENTILE))
  };
}

/** A line as x·cosθ + y·sinθ = ρ, θ ∈ [0, π). */
interface HoughLine {
  theta: number;
  rho: number;
}

/**
 * Dominant straight lines via a gradient-aligned Hough vote: each edge
 * pixel votes only around its own gradient normal (±4°), and votes are
 * unweighted so a long faint paper edge outvotes short dark ink. Peaks
 * are non-max suppressed over a θ/ρ neighbourhood (with the sign of ρ
 * flipping when θ wraps at 180°).
 */
function houghLines(field: GradientField, count: number): HoughLine[] {
  const { width, height, mag, dir, voteCut } = field;
  const thetaBins = 180;
  const diag = Math.ceil(Math.hypot(width, height));
  const rhoBins = 2 * diag;
  const acc = new Float32Array(thetaBins * rhoBins);
  const cosTable = new Float64Array(thetaBins);
  const sinTable = new Float64Array(thetaBins);
  for (let t = 0; t < thetaBins; t++) {
    cosTable[t] = Math.cos((t * Math.PI) / 180);
    sinTable[t] = Math.sin((t * Math.PI) / 180);
  }
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (mag[i] <= voteCut) continue;
      const base = Math.round((dir[i] * 180) / Math.PI);
      for (let dt = -4; dt <= 4; dt++) {
        const t = (((base + dt) % 180) + 180) % 180;
        const rho = x * cosTable[t] + y * sinTable[t];
        const r = Math.round(rho) + diag;
        if (r < 0 || r >= rhoBins) continue;
        acc[t * rhoBins + r] += 1;
      }
    }
  }

  const lines: HoughLine[] = [];
  const suppressed = new Uint8Array(acc.length);
  for (let n = 0; n < count; n++) {
    let bestIdx = -1;
    let bestVotes = 0;
    for (let i = 0; i < acc.length; i++) {
      if (!suppressed[i] && acc[i] > bestVotes) {
        bestVotes = acc[i];
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const t = Math.floor(bestIdx / rhoBins);
    const r = bestIdx - t * rhoBins;
    lines.push({ theta: (t * Math.PI) / 180, rho: r - diag });
    for (let dt = -8; dt <= 8; dt++) {
      const wrapped = t + dt < 0 || t + dt >= 180;
      const tt = (((t + dt) % 180) + 180) % 180;
      const rc = wrapped ? 2 * diag - r : r;
      for (let dr = -12; dr <= 12; dr++) {
        const rr = rc + dr;
        if (rr < 0 || rr >= rhoBins) continue;
        suppressed[tt * rhoBins + rr] = 1;
      }
    }
  }
  return lines;
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
}

function intersectLines(a: HoughLine, b: HoughLine): QuadPoint | null {
  const det =
    Math.cos(a.theta) * Math.sin(b.theta) -
    Math.sin(a.theta) * Math.cos(b.theta);
  if (Math.abs(det) < 1e-9) return null;
  return {
    x: (a.rho * Math.sin(b.theta) - b.rho * Math.sin(a.theta)) / det,
    y: (b.rho * Math.cos(a.theta) - a.rho * Math.cos(b.theta)) / det
  };
}

/**
 * Fraction of the a→b segment lying on a real, correctly oriented edge:
 * per sample point, an edge pixel above the support threshold whose
 * gradient runs along the side's normal must exist within ±2 px.
 */
function sideSupport(field: GradientField, a: QuadPoint, b: QuadPoint): number {
  const { width, height, mag, dir, supportCut } = field;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 4) return 0;
  const n = Math.max(16, Math.round(len));
  const nx = (b.y - a.y) / len;
  const ny = -(b.x - a.x) / len;
  let hits = 0;
  for (let s = 0; s <= n; s++) {
    const px = a.x + ((b.x - a.x) * s) / n;
    const py = a.y + ((b.y - a.y) * s) / n;
    let hit = 0;
    for (let o = -2; o <= 2; o++) {
      const qx = Math.round(px + nx * o);
      const qy = Math.round(py + ny * o);
      if (qx < 1 || qy < 1 || qx >= width - 1 || qy >= height - 1) continue;
      const i = qy * width + qx;
      if (mag[i] > supportCut) {
        const align = Math.abs(Math.cos(dir[i]) * nx + Math.sin(dir[i]) * ny);
        if (align > 0.8) {
          hit = 1;
          break;
        }
      }
    }
    hits += hit;
  }
  return hits / (n + 1);
}

function insideConvexQuad(p: QuadPoint, quad: PaperQuad): boolean {
  let sign = 0;
  for (let s = 0; s < 4; s++) {
    const a = quad[s];
    const b = quad[(s + 1) % 4];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross === 0) continue;
    const cs = Math.sign(cross);
    if (sign === 0) sign = cs;
    else if (cs !== sign) return false;
  }
  return true;
}

/**
 * Supported length (px) of `line` strictly inside `quad`, ignoring a
 * 4 px skirt along the quad boundary. A large value means the quad
 * swallowed a real boundary — e.g. a shadow-line quad containing the
 * true paper edge — and should lose to the tighter fit.
 */
function interiorLineLength(
  field: GradientField,
  line: HoughLine,
  quad: PaperQuad
): number {
  const { width, height, mag, supportCut } = field;
  const diag = Math.ceil(Math.hypot(width, height));
  const c = Math.cos(line.theta);
  const s = Math.sin(line.theta);
  let len = 0;
  for (let t = -diag; t <= diag; t++) {
    const x = c * line.rho - s * t;
    const y = s * line.rho + c * t;
    if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue;
    if (!insideConvexQuad({ x, y }, quad)) continue;
    let minD = Infinity;
    for (let e = 0; e < 4; e++) {
      const a = quad[e];
      const b = quad[(e + 1) % 4];
      const sideLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (sideLen < 1e-6) continue;
      const d = Math.abs(
        ((b.x - a.x) * (a.y - y) - (a.x - x) * (b.y - a.y)) / sideLen
      );
      minD = Math.min(minD, d);
    }
    if (minD < 4) continue;
    if (mag[Math.round(y) * width + Math.round(x)] > supportCut) len += 1;
  }
  return len;
}

/**
 * Score a candidate quad against the gradient field, or null when it is
 * not paper-plausible. The score rewards a perimeter lying on real
 * edges (mean and worst side) and larger areas (of two clean quads the
 * paper is the big one), and subtracts the interior-line penalty.
 */
function scoreQuadCandidate(
  quad: PaperQuad,
  field: GradientField,
  lines: HoughLine[],
  limits: QuadSearchLimits
): number | null {
  const { width, height } = field;
  const margin = 0.03 * Math.max(width, height);
  for (const p of quad) {
    if (
      p.x < -margin ||
      p.y < -margin ||
      p.x > width + margin ||
      p.y > height + margin
    ) {
      return null;
    }
  }
  const frac = polygonArea(quad) / (width * height);
  if (frac < limits.minAreaFraction || frac > limits.maxAreaFraction) {
    return null;
  }
  const supports = [
    sideSupport(field, quad[0], quad[1]),
    sideSupport(field, quad[1], quad[2]),
    sideSupport(field, quad[2], quad[3]),
    sideSupport(field, quad[3], quad[0])
  ];
  const minSup = Math.min(...supports);
  if (minSup < MIN_SIDE_SUPPORT) return null;
  const meanSup = supports.reduce((sum, v) => sum + v, 0) / 4;
  let penalty = 0;
  for (const line of lines) {
    penalty = Math.max(
      penalty,
      interiorLineLength(field, line, quad) / Math.max(width, height)
    );
  }
  return (0.5 * meanSup + 0.5 * minSup) * Math.sqrt(frac) - penalty;
}

/**
 * Assemble candidate quads from the Hough lines (two roughly parallel
 * pairs, adjacent sides at least 45° apart) and return the best-scoring
 * one, if any.
 */
function quadFromEdges(
  field: GradientField,
  lines: HoughLine[],
  limits: QuadSearchLimits
): { quad: PaperQuad; score: number } | null {
  let best: { quad: PaperQuad; score: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (angleDiff(lines[i].theta, lines[j].theta) > Math.PI / 6) continue;
      for (let k = 0; k < lines.length; k++) {
        if (k === i || k === j) continue;
        if (angleDiff(lines[i].theta, lines[k].theta) < Math.PI / 4) continue;
        for (let l = k + 1; l < lines.length; l++) {
          if (l === i || l === j) continue;
          if (angleDiff(lines[k].theta, lines[l].theta) > Math.PI / 6) {
            continue;
          }
          if (angleDiff(lines[i].theta, lines[l].theta) < Math.PI / 4) {
            continue;
          }
          const c1 = intersectLines(lines[i], lines[k]);
          const c2 = intersectLines(lines[k], lines[j]);
          const c3 = intersectLines(lines[j], lines[l]);
          const c4 = intersectLines(lines[l], lines[i]);
          if (!c1 || !c2 || !c3 || !c4) continue;
          const quad = [c1, c2, c3, c4] as PaperQuad;
          const score = scoreQuadCandidate(quad, field, lines, limits);
          if (score !== null && (!best || score > best.score)) {
            best = { quad, score };
          }
        }
      }
    }
  }
  return best;
}

/**
 * Find the paper in a photo. Returns the corner quad in source-image
 * coordinates, or null when no convincing paper region exists.
 */
export function detectPaperQuad(
  raster: RasterImage,
  options: DetectPaperOptions = {}
): PaperQuad | null {
  const workingWidth = options.workingWidth ?? DEFAULT_WORKING_WIDTH;
  const maxSaturation = options.maxSaturation ?? DEFAULT_MAX_SATURATION;
  const limits: QuadSearchLimits = {
    minAreaFraction: options.minAreaFraction ?? DEFAULT_MIN_AREA_FRACTION,
    maxAreaFraction: options.maxAreaFraction ?? DEFAULT_MAX_AREA_FRACTION,
    minSolidity: options.minSolidity ?? DEFAULT_MIN_SOLIDITY
  };

  let img = toIjsImage(raster);
  if (img.width > workingWidth) {
    img = img.resize({ width: workingWidth });
  }
  const scaleBack = raster.width / img.width;
  const working = toRaster(img);
  const { width, height } = working;

  // Otsu split on brightness; the paper is on the bright side. A busy
  // or bright background can defeat this (white desk under white paper)
  // — the sanity checks in quadFromMask turn those into a null rather
  // than a bogus crop, and the caller falls back to the whole frame.
  const gray = luminance(working);
  const brightCutoff = otsuThreshold(gray);

  // Strict pass: bright AND achromatic. This is what keeps a hand
  // gripping the paper out of the region — skin is bright enough to
  // pass Otsu against a dark room but far more saturated than paper.
  const strict = new Uint8Array(width * height);
  const loose = new Uint8Array(width * height);
  for (let i = 0; i < strict.length; i++) {
    if (gray[i] <= brightCutoff) continue;
    loose[i] = 1;
    const o = i * 4;
    const r = working.data[o];
    const g = working.data[o + 1];
    const b = working.data[o + 2];
    const max = Math.max(r, g, b);
    const saturation = max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
    if (saturation <= maxSaturation) strict[i] = 1;
  }

  // Coloured paper fails the strict pass entirely; fall back to the
  // brightness-only mask so it still gets detected (a hand holding
  // *coloured* paper merges again, but that's the pre-chroma behaviour
  // and the manual crop editor covers it).
  const regionQuad =
    quadFromMask(strict, width, height, limits) ??
    quadFromMask(loose, width, height, limits);

  // Shared judge: the gradient field of the blurred working image.
  const field = computeGradient(
    luminance(toRaster(img.gaussianBlur({ sigma: EDGE_BLUR_SIGMA }))),
    width,
    height
  );
  const lines = houghLines(field, MAX_HOUGH_LINES);

  const regionScore = regionQuad
    ? scoreQuadCandidate(regionQuad, field, lines, limits)
    : null;

  // The common bright-paper-on-dark-desk case: the region quad is
  // precise and well supported — skip the Hough assembly (live camera
  // detection calls this every few hundred ms).
  let quad = regionQuad;
  let score = regionScore ?? -Infinity;
  if (score < REGION_SCORE_SHORTCUT) {
    const edge = quadFromEdges(field, lines, limits);
    if (edge && edge.score > score) {
      quad = edge.quad;
      score = edge.score;
    }
  }
  if (!quad || score < MIN_QUAD_SCORE) return null;

  return orderQuad(
    quad.map((p) => ({ x: p.x * scaleBack, y: p.y * scaleBack }))
  );
}

/* --- Rectification ---------------------------------------------------------------- */

function distance(a: QuadPoint, b: QuadPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Warp the detected paper fronto-parallel. The output aspect follows the
 * quad's side lengths; corners are inset toward the centre first so edge
 * shadows and fingertips don't ride along into the crop.
 */
export function rectifyPaper(
  raster: RasterImage,
  quad: PaperQuad,
  options: RectifyPaperOptions = {}
): RasterImage {
  const inset = options.inset ?? DEFAULT_INSET;
  const maxDim = options.maxDim ?? DEFAULT_RECTIFY_MAX_DIM;

  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  const inner = quad.map((p) => ({
    x: p.x + (cx - p.x) * inset,
    y: p.y + (cy - p.y) * inset
  })) as PaperQuad;

  const [tl, tr, br, bl] = inner;
  const rectWidth = Math.max(distance(tl, tr), distance(bl, br));
  const rectHeight = Math.max(distance(tl, bl), distance(tr, br));
  const scale = Math.min(1, maxDim / Math.max(rectWidth, rectHeight, 1));
  const width = Math.max(1, Math.round(rectWidth * scale));
  const height = Math.max(1, Math.round(rectHeight * scale));

  // getPerspectiveWarp solves the homography mapping output pixels back
  // into the source (hence inverse: true on the transform).
  const { matrix } = getPerspectiveWarp(
    inner.map((p) => ({ column: p.x, row: p.y })),
    { width, height }
  );
  const warped = toIjsImage(raster).transform(matrix, {
    width,
    height,
    inverse: true
  });
  return toRaster(warped);
}
