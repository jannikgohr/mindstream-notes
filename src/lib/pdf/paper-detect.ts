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
 * Detection strategy: threshold on brightness, take the largest bright
 * region, and fit the maximum-area quadrilateral to its convex hull.
 * The hull is what makes fingers holding the paper tolerable — a finger
 * crossing the edge bites a concavity into the region, and the hull
 * bridges straight over it. Solidity (region area / hull area) is the
 * sanity check that the bright blob is actually paper-shaped.
 *
 * Fails soft: `detectPaperQuad` returns null whenever the scene doesn't
 * contain a convincing paper (no bright region, too small, fills the
 * whole frame, not quad-like) and callers fall back to the whole-frame
 * behaviour.
 */

import { Image, fromMask, getPerspectiveWarp } from 'image-js';
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
const DEFAULT_MIN_SOLIDITY = 0.8;
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

/**
 * Find the paper in a photo. Returns the corner quad in source-image
 * coordinates, or null when no convincing paper region exists.
 */
export function detectPaperQuad(
  raster: RasterImage,
  options: DetectPaperOptions = {}
): PaperQuad | null {
  const workingWidth = options.workingWidth ?? DEFAULT_WORKING_WIDTH;
  const minAreaFraction = options.minAreaFraction ?? DEFAULT_MIN_AREA_FRACTION;
  const maxAreaFraction = options.maxAreaFraction ?? DEFAULT_MAX_AREA_FRACTION;
  const minSolidity = options.minSolidity ?? DEFAULT_MIN_SOLIDITY;

  let img = toIjsImage(raster);
  if (img.width > workingWidth) {
    img = img.resize({ width: workingWidth });
  }
  const scaleBack = raster.width / img.width;

  // Otsu split on brightness; the paper is the bright side. A busy or
  // bright background can defeat this (white desk under white paper) —
  // the sanity checks below turn those into a null rather than a bogus
  // crop, and the caller falls back to the whole frame.
  const mask = img.grey().threshold();
  const rois = fromMask(mask).getRois({ kind: 'white' });
  if (rois.length === 0) return null;

  let roi = rois[0];
  for (const candidate of rois) {
    if (candidate.surface > roi.surface) roi = candidate;
  }

  const frameArea = img.width * img.height;
  if (roi.surface < minAreaFraction * frameArea) return null;
  if (roi.surface > maxAreaFraction * frameArea) return null;

  // Hull points come back relative to the ROI's bounding box.
  const hull: QuadPoint[] = roi.convexHull.points.map((p) => ({
    x: p.column + roi.origin.column,
    y: p.row + roi.origin.row
  }));
  const hullArea = polygonArea(hull);
  if (hullArea <= 0) return null;
  if (roi.surface / hullArea < minSolidity) return null;

  const quad = maxAreaQuad(hull);
  if (!quad) return null;
  // The quad must explain the hull — a degenerate fit means the bright
  // region wasn't quadrilateral to begin with.
  if (polygonArea(quad) < 0.8 * hullArea) return null;

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
