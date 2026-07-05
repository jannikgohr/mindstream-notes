/**
 * Pure mapping between a synced `SignatureRecord` (opaque JSON geometry on
 * the wire) and the `PdfSignatureSnapshot` the UI works with. Split out of
 * signature-storage.ts so the conversion logic is unit-testable without
 * dragging in the Tauri-backed API surface.
 */

import type { SignatureRecord } from '$lib/api/signatures';
import type { PdfSignatureImage, PdfSignatureSnapshot } from './types';

function normaliseImage(value: unknown): PdfSignatureImage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const image = value as Partial<PdfSignatureImage>;
  if (
    image.mimeType !== 'image/png' ||
    typeof image.dataUrl !== 'string' ||
    !image.dataUrl.startsWith('data:image/png;base64,') ||
    typeof image.width !== 'number' ||
    typeof image.height !== 'number' ||
    !Number.isFinite(image.width) ||
    !Number.isFinite(image.height) ||
    image.width <= 0 ||
    image.height <= 0
  ) {
    return undefined;
  }
  return {
    dataUrl: image.dataUrl,
    width: image.width,
    height: image.height,
    mimeType: 'image/png'
  };
}

/**
 * Decode a record's JSON payload into a UI snapshot. Returns null when the
 * payload is malformed or carries no strokes — callers filter those out.
 */
export function recordToSnapshot(
  rec: SignatureRecord
): PdfSignatureSnapshot | null {
  try {
    const geom = JSON.parse(rec.data) as Omit<PdfSignatureSnapshot, 'id'>;
    if (!Array.isArray(geom?.strokes) || geom.strokes.length === 0) return null;
    const image = normaliseImage(geom.image);
    return {
      id: rec.id,
      width: geom.width,
      height: geom.height,
      strokes: geom.strokes,
      ...(image ? { image } : {})
    };
  } catch {
    return null;
  }
}

/** Serialise a snapshot's geometry (dropping the id) for the wire. */
export function snapshotToData(sig: PdfSignatureSnapshot): string {
  const { id: _id, ...geom } = sig;
  return JSON.stringify(geom);
}
