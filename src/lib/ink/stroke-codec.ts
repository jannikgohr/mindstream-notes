/**
 * The on-wire stroke payload.
 *
 * v1 packed geometry as float32 x/y pairs; v2 adds per-point pressure.
 * Both are read, only v2 is written. Decoding is deliberately total —
 * a malformed payload yields `null` rather than throwing, so one corrupt
 * stroke can't take a whole page down.
 */

import type { InkPoint } from '$lib/ink/page';
import {
  DEFAULT_WIDTH,
  type DecodedPayload,
  type InProgressStroke
} from './stroke-types';

export const PAYLOAD_VERSION_V1 = 1;
export const PAYLOAD_VERSION_V2 = 2;

export function encodePayloadV2(stroke: InProgressStroke): Uint8Array {
  const out = new ArrayBuffer(13 + stroke.points.length * 12);
  const view = new DataView(out);
  let offset = 0;
  view.setUint8(offset, PAYLOAD_VERSION_V2);
  offset += 1;
  view.setUint32(offset, stroke.color >>> 0, true);
  offset += 4;
  view.setFloat32(offset, stroke.width, true);
  offset += 4;
  view.setUint32(offset, stroke.points.length, true);
  offset += 4;
  for (const point of stroke.points) {
    view.setFloat32(offset, point.x, true);
    offset += 4;
    view.setFloat32(offset, point.y, true);
    offset += 4;
  }
  for (const point of stroke.points) {
    view.setFloat32(offset, point.pressure, true);
    offset += 4;
  }
  return new Uint8Array(out);
}

export function decodePayload(bytes: Uint8Array): DecodedPayload | null {
  if (bytes.byteLength === 0) return null;
  switch (bytes[0]) {
    case PAYLOAD_VERSION_V1:
      return decodePayloadV1(bytes);
    case PAYLOAD_VERSION_V2:
      return decodePayloadV2(bytes);
    default:
      return null;
  }
}

export function decodePayloadV1(bytes: Uint8Array): DecodedPayload | null {
  if (bytes.byteLength < 9) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const color = view.getUint32(1, true);
  const count = view.getUint32(5, true);
  const expected = 9 + count * 12;
  if (bytes.byteLength !== expected) return null;
  return decodeGeometry(view, 9, count, color, DEFAULT_WIDTH);
}

export function decodePayloadV2(bytes: Uint8Array): DecodedPayload | null {
  if (bytes.byteLength < 13) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const color = view.getUint32(1, true);
  const width = sanitizeWidth(view.getFloat32(5, true));
  const count = view.getUint32(9, true);
  const expected = 13 + count * 12;
  if (bytes.byteLength !== expected) return null;
  return decodeGeometry(view, 13, count, color, width);
}

export function decodeGeometry(
  view: DataView,
  offset: number,
  count: number,
  color: number,
  width: number
): DecodedPayload | null {
  const points: InkPoint[] = [];
  for (let i = 0; i < count; i += 1) {
    points.push({
      x: view.getFloat32(offset, true),
      y: view.getFloat32(offset + 4, true),
      pressure: 1
    });
    offset += 8;
  }
  for (let i = 0; i < count; i += 1) {
    points[i].pressure = sanitizePressure(view.getFloat32(offset, true));
    offset += 4;
  }
  return {
    color: color >>> 0,
    width,
    points
  };
}

export function sanitizePressure(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(1, value) : 1;
}

export function sanitizeWidth(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_WIDTH;
}

export function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function sanitizedPoints(points: InkPoint[]): InkPoint[] {
  return points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({
      x: point.x,
      y: point.y,
      pressure: sanitizePressure(point.pressure)
    }));
}
