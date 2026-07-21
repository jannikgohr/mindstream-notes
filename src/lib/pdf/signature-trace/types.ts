import type { PdfInkStroke, PdfStrokePoint } from '../types';

/**
 * Shared shapes and pad-space constants for signature tracing.
 *
 * The pad dimensions are the drawing pad's own canvas
 * (SignaturePadDialog), so imported and hand-drawn signatures are
 * interchangeable everywhere downstream.
 */

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
  /**
   * Components whose median darkness falls below this fraction of the
   * frame's reference ink darkness are dropped as paper noise (see
   * removeFaintComponents). Defaults to FAINT_COMPONENT_RATIO; pass 0
   * to disable.
   */
  faintComponentRatio?: number;
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

/** The eight 8-connected neighbour offsets, clockwise. Shared by every
 * mask walk in the pipeline. */
export const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1]
];
