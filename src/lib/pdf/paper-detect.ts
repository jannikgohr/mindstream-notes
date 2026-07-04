/**
 * Paper detection + perspective rectification for the signature import.
 *
 * Finds the sheet of paper in a photo (bright quadrilateral against a
 * darker scene), and warps it fronto-parallel so the tracing pipeline
 * gets the full resolution budget on the paper instead of the room.
 * Pure data-in/data-out like signature-trace.ts — image-js supplies the
 * heavy lifting (Otsu mask, connected regions, convex hull, 4-point
 * perspective warp) and runs without any DOM, so this module is fully
 * unit-testable.
 *
 * Detection strategy: paper is *bright and achromatic*. The strict pass
 * masks pixels that clear the Otsu brightness split AND have low colour
 * saturation — that split is what keeps a hand holding the paper out of
 * the region: skin of any tone is strongly chromatic while white paper
 * is not, so this needs no skin model and is exposure-robust (saturation
 * is chroma relative to brightness). Coloured paper fails the strict
 * pass, so a brightness-only fallback pass preserves the old behaviour
 * for it. The largest region's convex hull gets the maximum-area
 * quadrilateral fitted; the hull is what makes remaining occlusions
 * tolerable — a finger crossing the edge bites a concavity into the
 * region, and the hull bridges straight over it. Solidity (region area
 * / hull area) is the sanity check that the blob is paper-shaped.
 *
 * Fails soft: `detectPaperQuad` returns null whenever the scene doesn't
 * contain a convincing paper (no bright region, too small, fills the
 * whole frame, not quad-like) and callers fall back to the whole-frame
 * behaviour.
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
  const quad =
    quadFromMask(strict, width, height, limits) ??
    quadFromMask(loose, width, height, limits);
  if (!quad) return null;

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
