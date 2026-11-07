/**
 * The style the Android live-ink overlay paints its wet stroke with.
 *
 * The overlay is replaced by the canvas stroke a moment after the pen
 * lifts, so both must look the same or the stroke visibly jumps. Kotlin
 * draws in surface (device) pixels with a width of
 * `min + (max - min) · pressure`. The canvas draws
 * `max(1, width · scale · pressureWidth(pressure))` CSS pixels, and
 * `pressureWidth` runs linearly from 0.25 to 1, so the two agree exactly
 * once the thinnest width clears the canvas's one-pixel floor.
 */

import { displayColor } from './editor-helpers';

export interface LiveInkStyle {
  colorArgb: number;
  minWidthPx: number;
  maxWidthPx: number;
}

export function liveInkStyle(options: {
  colorArgb: number;
  width: number;
  scale: number;
  devicePixelRatio: number;
  /** Dark page theme, which the canvas applies to blank pages only. */
  pageDark: boolean;
  /** The pen is over a PDF page, whose ink keeps its stored colours. */
  onBackgroundPage: boolean;
}): LiveInkStyle {
  const cssWidth = options.width * options.scale;
  const dpr = options.devicePixelRatio > 0 ? options.devicePixelRatio : 1;
  return {
    colorArgb: options.onBackgroundPage
      ? options.colorArgb >>> 0
      : displayColor(options.colorArgb, options.pageDark),
    minWidthPx: Math.max(1, cssWidth * 0.25) * dpr,
    maxWidthPx: Math.max(1, cssWidth) * dpr
  };
}
