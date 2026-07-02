/**
 * DOM edge of the signature import: turn a picked image file or a live
 * camera frame into the plain `RasterImage` the pure tracing pipeline
 * consumes (see signature-trace.ts). Kept deliberately thin — all the
 * interesting logic lives in the testable module; this file is just
 * canvas plumbing shared by both input paths.
 */

import type { RasterImage } from './signature-trace';

/**
 * Cap on the longer image side before tracing. Phone photos are 3-4k px;
 * thinning cost scales with area and a signature doesn't need more than
 * ~1000px of resolution to trace cleanly.
 */
export const IMPORT_MAX_DIMENSION = 1000;

/**
 * Cap for the initial decode, deliberately above the trace cap: paper
 * detection (paper-detect.ts) crops to the sheet first, and the crop
 * should still have real pixels left after the perspective warp. The
 * whole-frame fallback downscales to IMPORT_MAX_DIMENSION afterwards.
 */
export const IMPORT_DECODE_MAX_DIMENSION = 2000;

function drawToRaster(
  source: CanvasImageSource,
  srcWidth: number,
  srcHeight: number,
  maxDim: number
): RasterImage {
  const scale = Math.min(1, maxDim / Math.max(srcWidth, srcHeight));
  const width = Math.max(1, Math.round(srcWidth * scale));
  const height = Math.max(1, Math.round(srcHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  // White base so transparent PNG regions read as paper, matching the
  // luminance step's alpha handling.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  return { width, height, data: imageData.data };
}

/** Decode a picked image file (or camera-app capture) into a raster. */
export async function rasterFromBlob(
  blob: Blob,
  maxDim: number = IMPORT_MAX_DIMENSION
): Promise<RasterImage> {
  const bitmap = await createImageBitmap(blob);
  try {
    return drawToRaster(bitmap, bitmap.width, bitmap.height, maxDim);
  } finally {
    bitmap.close();
  }
}

/** Grab the current frame of a playing `<video>` (getUserMedia preview). */
export function rasterFromVideo(
  video: HTMLVideoElement,
  maxDim: number = IMPORT_MAX_DIMENSION
): RasterImage {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new Error('Video has no frame yet');
  return drawToRaster(video, width, height, maxDim);
}

/**
 * Open the rear camera for a live capture preview. Returns the stream
 * for the caller to attach to a `<video>` and stop when done. Throws
 * where getUserMedia is unavailable or denied — callers fall back to a
 * file input with `capture` (which opens the OS camera app instead).
 */
export async function openCameraStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera API unavailable');
  }
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' },
    audio: false
  });
}

export function stopCameraStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}
