/**
 * Pure mapping between a synced `SignatureRecord` (opaque JSON geometry on
 * the wire) and the `PdfSignatureSnapshot` the UI works with. Split out of
 * signature-storage.ts so the conversion logic is unit-testable without
 * dragging in the Tauri-backed API surface.
 */

import type { SignatureRecord } from '$lib/api/signatures';
import type { PdfSignatureImage, PdfSignatureSnapshot } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normaliseImage(value: unknown): PdfSignatureImage | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.mimeType !== 'image/png' ||
    typeof value.dataUrl !== 'string' ||
    !value.dataUrl.startsWith('data:image/png;base64,') ||
    !isPositiveFiniteNumber(value.width) ||
    !isPositiveFiniteNumber(value.height)
  ) {
    return undefined;
  }
  return {
    dataUrl: value.dataUrl,
    width: value.width,
    height: value.height,
    mimeType: 'image/png'
  };
}

export function normaliseSignatureSnapshot(
  value: unknown,
  fallbackId?: string
): PdfSignatureSnapshot | null {
  if (!isRecord(value)) return null;
  const id =
    typeof value.id === 'string' && value.id.length > 0 ? value.id : fallbackId;
  if (
    !id ||
    !isPositiveFiniteNumber(value.width) ||
    !isPositiveFiniteNumber(value.height) ||
    !Array.isArray(value.strokes) ||
    value.strokes.length === 0
  ) {
    return null;
  }

  const image = normaliseImage(value.image);
  return {
    id,
    width: value.width,
    height: value.height,
    strokes: value.strokes,
    ...(image ? { image } : {})
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
    const geom: unknown = JSON.parse(rec.data);
    return normaliseSignatureSnapshot(geom, rec.id);
  } catch {
    return null;
  }
}

/** Serialise a snapshot's geometry (dropping the id) for the wire. */
export function snapshotToData(sig: PdfSignatureSnapshot): string {
  const { id: _id, ...geom } = sig;
  return JSON.stringify(geom);
}
