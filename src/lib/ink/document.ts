import * as Y from 'yjs';
import { pointToSegmentDistanceSq, type InkPoint } from '$lib/ink/page';

const STROKES_KEY = 'strokes';
const FIELD_ID = 'id';
const FIELD_TOMBSTONED = 'tombstoned';
const FIELD_PAYLOAD = 'payload';

const PAYLOAD_VERSION_V1 = 1;
const PAYLOAD_VERSION_V2 = 2;

export const DEFAULT_COLOR = 0xff000000;
export const DEFAULT_WIDTH = 4;

export interface InkStroke {
  id: string;
  color: number;
  width: number;
  points: InkPoint[];
  bounds?: StrokeBounds;
}

export type UndoOp =
  | { kind: 'strokeAdded'; id: string }
  | { kind: 'eraserDrag'; ids: string[] }
  | { kind: 'clearAll'; ids: string[] };

interface DecodedPayload {
  color: number;
  width: number;
  points: InkPoint[];
}

export interface StrokeBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface StrokeMeta extends InkStroke {
  bounds: StrokeBounds;
}

interface InProgressStroke {
  color: number;
  width: number;
  points: InkPoint[];
}

export interface MutationResult<T> {
  value: T;
  update: Uint8Array | null;
}

export class InkDocument {
  readonly doc: Y.Doc;
  private readonly strokes: Y.Array<Y.Map<unknown>>;
  private inProgress: InProgressStroke | null = null;
  private visibleStrokeCache: StrokeMeta[] | null = null;
  readonly undo: UndoOp[] = [];
  readonly redo: UndoOp[] = [];

  constructor(doc = new Y.Doc()) {
    this.doc = doc;
    this.strokes = doc.getArray<Y.Map<unknown>>(STROKES_KEY);
  }

  static fromBytes(bytes: Uint8Array | number[]): InkDocument {
    const doc = new Y.Doc();
    const state = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (state.byteLength > 0) {
      Y.applyUpdate(doc, state);
    }
    return new InkDocument(doc);
  }

  encode(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  encodeStateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  encodeDiffForStateVector(stateVector: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc, stateVector);
  }

  applyRemoteUpdate(update: Uint8Array): boolean {
    try {
      Y.applyUpdate(this.doc, update);
      this.cancelStroke();
      this.invalidateVisibleStrokeCache();
      this.undo.length = 0;
      this.redo.length = 0;
      return true;
    } catch {
      return false;
    }
  }

  transactLocalUpdate<T>(fn: () => T): MutationResult<T> {
    const before = Y.encodeStateVector(this.doc);
    const value = fn();
    const update = Y.encodeStateAsUpdate(this.doc, before);
    return {
      value,
      update: update.byteLength > 2 ? update : null
    };
  }

  visibleStrokes(): InkStroke[] {
    return this.ensureVisibleStrokeCache().map(strokeFromMeta);
  }

  contentMaxY(): number {
    return this.ensureVisibleStrokeCache().reduce(
      (max, stroke) => Math.max(max, stroke.bounds.maxY),
      0
    );
  }

  strokeIds(
    includeTombstoned = true
  ): Array<{ id: string; tombstoned: boolean }> {
    const out: Array<{ id: string; tombstoned: boolean }> = [];
    for (const stroke of this.strokes.toArray()) {
      const id = stroke.get(FIELD_ID);
      if (typeof id !== 'string') continue;
      const tombstoned = stroke.get(FIELD_TOMBSTONED) === true;
      if (!includeTombstoned && tombstoned) continue;
      out.push({ id, tombstoned });
    }
    return out;
  }

  beginStroke(color = DEFAULT_COLOR, width = DEFAULT_WIDTH): void {
    this.inProgress = {
      color: color >>> 0,
      width: sanitizeWidth(width),
      points: []
    };
  }

  pushPoint(x: number, y: number, pressure = 1): void {
    if (!this.inProgress) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.inProgress.points.push({
      x,
      y,
      pressure: sanitizePressure(pressure)
    });
  }

  cancelStroke(): void {
    this.inProgress = null;
  }

  endStroke(recordUndo = true): MutationResult<string | null> {
    return this.transactLocalUpdate(() => {
      const stroke = this.inProgress;
      this.inProgress = null;
      if (!stroke || stroke.points.length === 0) return null;

      const id = `stroke_${randomId()}`;
      const map = new Y.Map<unknown>();
      map.set(FIELD_ID, id);
      map.set(FIELD_TOMBSTONED, false);
      map.set(FIELD_PAYLOAD, encodePayloadV2(stroke));
      this.strokes.push([map]);
      this.invalidateVisibleStrokeCache();
      if (recordUndo) {
        this.recordOp({ kind: 'strokeAdded', id });
      }
      return id;
    });
  }

  setStrokeTombstoned(id: string, tombstoned: boolean): boolean {
    const stroke = this.findStrokeMap(id);
    if (!stroke) return false;
    const current = stroke.get(FIELD_TOMBSTONED) === true;
    stroke.set(FIELD_TOMBSTONED, tombstoned);
    if (current !== tombstoned) {
      this.invalidateVisibleStrokeCache();
    }
    return true;
  }

  tombstoneStrokes(ids: Iterable<string>): number {
    const wanted = new Set(ids);
    if (wanted.size === 0) return 0;
    let count = 0;
    for (const stroke of this.strokes.toArray()) {
      const id = stroke.get(FIELD_ID);
      if (typeof id !== 'string' || !wanted.has(id)) continue;
      if (stroke.get(FIELD_TOMBSTONED) === true) continue;
      stroke.set(FIELD_TOMBSTONED, true);
      count += 1;
    }
    if (count > 0) {
      this.invalidateVisibleStrokeCache();
    }
    return count;
  }

  clearAll(): MutationResult<string[]> {
    return this.transactLocalUpdate(() => {
      const visible = this.strokeIds(false).map((entry) => entry.id);
      for (const id of visible) {
        this.setStrokeTombstoned(id, true);
      }
      if (visible.length > 0) {
        this.recordOp({ kind: 'clearAll', ids: visible });
      }
      return visible;
    });
  }

  eraseAt(
    point: { x: number; y: number },
    radius: number
  ): MutationResult<string[]> {
    return this.eraseAtMany([point], radius);
  }

  eraseAtMany(
    points: Array<{ x: number; y: number }>,
    radius: number,
    ignoreIds: Iterable<string> = []
  ): MutationResult<string[]> {
    const validPoints = points.filter(
      (point) => Number.isFinite(point.x) && Number.isFinite(point.y)
    );
    if (validPoints.length === 0) {
      return { value: [], update: null };
    }

    const ignored = new Set(ignoreIds);
    const hitIds = new Set<string>();
    const candidates = this.ensureVisibleStrokeCache();
    for (const point of validPoints) {
      for (const meta of candidates) {
        if (ignored.has(meta.id) || hitIds.has(meta.id)) continue;
        if (strokeHitAt(meta, point, radius)) {
          hitIds.add(meta.id);
        }
      }
    }

    if (hitIds.size === 0) {
      return { value: [], update: null };
    }

    return this.transactLocalUpdate(() => {
      const erased = this.tombstoneStrokeSet(hitIds);
      if (erased.length > 0 && this.visibleStrokeCache) {
        const erasedSet = new Set(erased);
        this.visibleStrokeCache = this.visibleStrokeCache.filter(
          (meta) => !erasedSet.has(meta.id)
        );
      }
      return erased;
    });
  }

  finishEraserDrag(ids: Iterable<string>): void {
    const unique = [...new Set(ids)].sort();
    if (unique.length > 0) {
      this.recordOp({ kind: 'eraserDrag', ids: unique });
    }
  }

  undoLast(): MutationResult<boolean> {
    return this.transactLocalUpdate(() => {
      const op = this.undo.pop();
      if (!op) return false;
      applyUndoOp(this, op);
      this.redo.push(op);
      return true;
    });
  }

  redoLast(): MutationResult<boolean> {
    return this.transactLocalUpdate(() => {
      const op = this.redo.pop();
      if (!op) return false;
      applyRedoOp(this, op);
      this.undo.push(op);
      return true;
    });
  }

  private recordOp(op: UndoOp): void {
    this.undo.push(op);
    this.redo.length = 0;
  }

  private findStrokeMap(id: string): Y.Map<unknown> | null {
    return (
      this.strokes.toArray().find((stroke) => stroke.get(FIELD_ID) === id) ??
      null
    );
  }

  private ensureVisibleStrokeCache(): StrokeMeta[] {
    if (this.visibleStrokeCache) return this.visibleStrokeCache;
    const out: StrokeMeta[] = [];
    for (const stroke of this.strokes.toArray()) {
      if (stroke.get(FIELD_TOMBSTONED) === true) continue;
      const id = stroke.get(FIELD_ID);
      const payload = stroke.get(FIELD_PAYLOAD);
      if (typeof id !== 'string' || !(payload instanceof Uint8Array)) {
        continue;
      }
      const decoded = decodePayload(payload);
      if (!decoded) continue;
      out.push({
        id,
        color: decoded.color,
        width: decoded.width,
        points: decoded.points,
        bounds: boundsOfPoints(decoded.points)
      });
    }
    this.visibleStrokeCache = out;
    return out;
  }

  private invalidateVisibleStrokeCache(): void {
    this.visibleStrokeCache = null;
  }

  private tombstoneStrokeSet(ids: Set<string>): string[] {
    if (ids.size === 0) return [];
    const erased: string[] = [];
    for (const stroke of this.strokes.toArray()) {
      const id = stroke.get(FIELD_ID);
      if (typeof id !== 'string' || !ids.has(id)) continue;
      if (stroke.get(FIELD_TOMBSTONED) === true) continue;
      stroke.set(FIELD_TOMBSTONED, true);
      erased.push(id);
    }
    return erased;
  }
}

export function strokesHitAt(
  strokes: InkStroke[],
  point: { x: number; y: number },
  radius: number
): InkStroke[] {
  return strokes.filter((stroke) =>
    strokeHitAt(
      { ...stroke, bounds: boundsOfPoints(stroke.points) },
      point,
      radius
    )
  );
}

function strokeHitAt(
  stroke: StrokeMeta,
  point: { x: number; y: number },
  radius: number
): boolean {
  if (!boundsContainPoint(stroke.bounds, point, radius)) return false;
  const radiusSq = radius * radius;
  for (let i = 1; i < stroke.points.length; i += 1) {
    if (
      pointToSegmentDistanceSq(point, stroke.points[i - 1], stroke.points[i]) <=
      radiusSq
    ) {
      return true;
    }
  }
  return false;
}

function strokeFromMeta(meta: StrokeMeta): InkStroke {
  return {
    id: meta.id,
    color: meta.color,
    width: meta.width,
    points: meta.points,
    bounds: meta.bounds
  };
}

function boundsOfPoints(points: InkPoint[]): StrokeBounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (minX === Number.POSITIVE_INFINITY) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  return { minX, minY, maxX, maxY };
}

function boundsContainPoint(
  bounds: StrokeBounds,
  point: { x: number; y: number },
  padding: number
): boolean {
  return (
    point.x >= bounds.minX - padding &&
    point.x <= bounds.maxX + padding &&
    point.y >= bounds.minY - padding &&
    point.y <= bounds.maxY + padding
  );
}

function applyUndoOp(doc: InkDocument, op: UndoOp): void {
  switch (op.kind) {
    case 'strokeAdded':
      doc.setStrokeTombstoned(op.id, true);
      break;
    case 'eraserDrag':
    case 'clearAll':
      for (const id of op.ids) {
        doc.setStrokeTombstoned(id, false);
      }
      break;
  }
}

function applyRedoOp(doc: InkDocument, op: UndoOp): void {
  switch (op.kind) {
    case 'strokeAdded':
      doc.setStrokeTombstoned(op.id, false);
      break;
    case 'eraserDrag':
    case 'clearAll':
      for (const id of op.ids) {
        doc.setStrokeTombstoned(id, true);
      }
      break;
  }
}

function encodePayloadV2(stroke: InProgressStroke): Uint8Array {
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

function decodePayload(bytes: Uint8Array): DecodedPayload | null {
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

function decodePayloadV1(bytes: Uint8Array): DecodedPayload | null {
  if (bytes.byteLength < 9) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const color = view.getUint32(1, true);
  const count = view.getUint32(5, true);
  const expected = 9 + count * 12;
  if (bytes.byteLength !== expected) return null;
  return decodeGeometry(view, 9, count, color, DEFAULT_WIDTH);
}

function decodePayloadV2(bytes: Uint8Array): DecodedPayload | null {
  if (bytes.byteLength < 13) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const color = view.getUint32(1, true);
  const width = sanitizeWidth(view.getFloat32(5, true));
  const count = view.getUint32(9, true);
  const expected = 13 + count * 12;
  if (bytes.byteLength !== expected) return null;
  return decodeGeometry(view, 13, count, color, width);
}

function decodeGeometry(
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

function sanitizePressure(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(1, value) : 1;
}

function sanitizeWidth(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_WIDTH;
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
