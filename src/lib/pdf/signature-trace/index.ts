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
 * speck removal (size, border blobs, relative darkness) → Zhang-Suen
 * thinning → skeleton walk into polylines → Douglas-Peucker
 * simplification → uniform fit into the signature pad's coordinate
 * space. The output is the same stroke geometry the drawing pad
 * produces, so everything downstream (picker previews, placement, PDF
 * /Ink export, sync) works unchanged.
 */

import type { PdfInkStroke } from '../types';
import {
  SIGNATURE_PAD_HEIGHT,
  SIGNATURE_PAD_WIDTH,
  type RasterImage,
  type SignatureMask,
  type TracedSignature,
  type TraceSignatureOptions
} from './types';
import { binarizeAdaptive, bridgeSmallGaps, inkSignal } from './binarize';
import {
  FAINT_COMPONENT_RATIO,
  computeInkAlpha,
  removeBorderBlobs,
  removeFaintComponents,
  removeSpecks
} from './denoise';
import { simplifyPolyline, thin, traceSkeleton } from './skeleton';
import { attachMeasuredWidths, fitToPad } from './fit';

export * from './types';
export * from './binarize';
export * from './denoise';
export * from './skeleton';
export * from './fit';

// ~2% of the shorter side: at a 1000px trace a marker stroke's half-
// width is ~7px while a finger's is ~35px, so 20px separates them with
// margin on both sides.
function defaultMinComponentSize(width: number, height: number): number {
  return Math.max(8, Math.round((width * height) / 20000));
}

function defaultBorderBlobThickness(width: number, height: number): number {
  return Math.max(6, Math.round(Math.min(width, height) * 0.02));
}

export function extractSignatureMask(
  image: RasterImage,
  options: TraceSignatureOptions = {}
): SignatureMask {
  const sensitivity = Math.min(1, Math.max(0, options.sensitivity ?? 0.5));
  const signal = inkSignal(image);
  const mask = binarizeAdaptive(signal, image.width, image.height, sensitivity);
  // Border clutter goes first so bridging can never attach the
  // signature to a finger/table blob and lose both to the rejection;
  // bridging precedes despeckling so a dotted stroke is size-judged as
  // the one stroke it is, not as disposable fragments.
  const borderThickness =
    options.borderBlobThickness ??
    defaultBorderBlobThickness(image.width, image.height);
  const deblobbed =
    borderThickness > 0 ? removeBorderBlobs(mask, borderThickness) : mask;
  const despeckled = removeSpecks(
    bridgeSmallGaps(deblobbed),
    options.minComponentSize ??
      defaultMinComponentSize(image.width, image.height)
  );
  return {
    mask: removeFaintComponents(
      despeckled,
      signal,
      options.faintComponentRatio ?? FAINT_COMPONENT_RATIO
    ),
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
