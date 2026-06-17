import * as Y from 'yjs';
import { pointToSegmentDistanceSq, type InkPoint } from '$lib/ink/page';

const STROKES_KEY = 'strokes';
const FIELD_ID = 'id';
const FIELD_TOMBSTONED = 'tombstoned';
const FIELD_PAYLOAD = 'payload';

const PAYLOAD_VERSION_V1 = 1;
const PAYLOAD_VERSION_V2 = 2;
const STROKE_INDEX_TILE_SIZE = 512;

export const DEFAULT_COLOR = 0xff000000;
export const DEFAULT_WIDTH = 4;

export interface InkStroke {
  id: string;
  color: number;
  width: number;
  points: InkPoint[];
  bounds?: StrokeBounds;
}

export interface StrokeTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  widthScale: number;
}

export type UndoOp =
  | { kind: 'strokeAdded'; id: string }
  | { kind: 'eraserDrag'; ids: string[] }
  | { kind: 'clearAll'; ids: string[] }
  | { kind: 'selectionDelete'; ids: string[] }
  | { kind: 'selectionMove'; ids: string[]; dx: number; dy: number }
  | {
      kind: 'selectionTransform';
      ids: string[];
      transform: StrokeTransform;
      inverse: StrokeTransform;
    };

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

interface StrokeSpatialIndex {
  tileSize: number;
  buckets: Map<string, StrokeMeta[]>;
  maxStrokeWidth: number;
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
  private strokeMapCache: Map<string, Y.Map<unknown>> | null = null;
  private spatialIndexCache: StrokeSpatialIndex | null = null;
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
      this.invalidateStrokeMapCache();
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

  visibleStrokeCount(): number {
    return this.ensureVisibleStrokeCache().length;
  }

  visibleStrokesInBounds(bounds: StrokeBounds, extraPadding = 0): InkStroke[] {
    return this.strokeMetasInBounds(bounds, extraPadding).map(strokeFromMeta);
  }

  strokeIdsInLasso(points: Array<{ x: number; y: number }>): string[] {
    if (points.length < 3) return [];
    const bounds = boundsOfPoints(points.map((p) => ({ ...p, pressure: 1 })));
    return this.strokeMetasInBounds(bounds, 0)
      .filter((stroke) => strokeIntersectsLasso(stroke, points))
      .map((stroke) => stroke.id);
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
      this.strokeMapCache?.set(id, map);
      this.invalidateVisibleStrokeCache();
      if (recordUndo) {
        this.recordOp({ kind: 'strokeAdded', id });
      }
      return id;
    });
  }

  setStrokeTombstoned(id: string, tombstoned: boolean): boolean {
    return this.setStrokesTombstoned([id], tombstoned) > 0;
  }

  setStrokesTombstoned(ids: Iterable<string>, tombstoned: boolean): number {
    const wanted = new Set(ids);
    if (wanted.size === 0) return 0;
    const strokeMaps = this.ensureStrokeMapCache();
    let count = 0;
    for (const id of wanted) {
      const stroke = strokeMaps.get(id);
      if (!stroke) continue;
      if (stroke.get(FIELD_TOMBSTONED) === tombstoned) continue;
      stroke.set(FIELD_TOMBSTONED, tombstoned);
      count += 1;
    }
    if (count > 0) {
      this.invalidateVisibleStrokeCache();
    }
    return count;
  }

  tombstoneStrokes(ids: Iterable<string>): number {
    return this.setStrokesTombstoned(ids, true);
  }

  clearAll(): MutationResult<string[]> {
    return this.transactLocalUpdate(() => {
      const visible = this.strokeIds(false).map((entry) => entry.id);
      this.setStrokesTombstoned(visible, true);
      if (visible.length > 0) {
        this.recordOp({ kind: 'clearAll', ids: visible });
      }
      return visible;
    });
  }

  deleteStrokes(ids: Iterable<string>): MutationResult<string[]> {
    return this.transactLocalUpdate(() => {
      const deleted = this.tombstoneStrokeSet(new Set(ids));
      if (deleted.length > 0) {
        this.recordOp({ kind: 'selectionDelete', ids: deleted });
        if (this.visibleStrokeCache) {
          const deletedSet = new Set(deleted);
          this.visibleStrokeCache = this.visibleStrokeCache.filter(
            (meta) => !deletedSet.has(meta.id)
          );
          this.invalidateSpatialIndexCache();
        }
      }
      return deleted;
    });
  }

  translateStrokes(
    ids: Iterable<string>,
    dx: number,
    dy: number
  ): MutationResult<string[]> {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      return { value: [], update: null };
    }
    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
      return { value: [], update: null };
    }
    return this.transactLocalUpdate(() => {
      const moved = this.translateStrokeSet(new Set(ids), dx, dy);
      if (moved.length > 0) {
        this.recordOp({ kind: 'selectionMove', ids: moved, dx, dy });
      }
      return moved;
    });
  }

  transformStrokes(
    ids: Iterable<string>,
    transform: StrokeTransform
  ): MutationResult<string[]> {
    if (!validTransform(transform)) {
      return { value: [], update: null };
    }
    const inverse = invertTransform(transform);
    if (!inverse) return { value: [], update: null };
    if (transformIsIdentity(transform)) {
      return { value: [], update: null };
    }
    return this.transactLocalUpdate(() => {
      const transformed = this.transformStrokeSet(new Set(ids), transform);
      if (transformed.length > 0) {
        this.recordOp({
          kind: 'selectionTransform',
          ids: transformed,
          transform,
          inverse
        });
      }
      return transformed;
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
    for (const point of validPoints) {
      for (const meta of this.strokeMetasAtPoint(point, radius)) {
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
        this.invalidateSpatialIndexCache();
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
    return this.ensureStrokeMapCache().get(id) ?? null;
  }

  private ensureStrokeMapCache(): Map<string, Y.Map<unknown>> {
    if (this.strokeMapCache) return this.strokeMapCache;
    const out = new Map<string, Y.Map<unknown>>();
    for (const stroke of this.strokes.toArray()) {
      const id = stroke.get(FIELD_ID);
      if (typeof id === 'string') {
        out.set(id, stroke);
      }
    }
    this.strokeMapCache = out;
    return out;
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

  private strokeMetasInBounds(
    bounds: StrokeBounds,
    extraPadding: number
  ): StrokeMeta[] {
    const index = this.ensureSpatialIndexCache();
    const padding = index.maxStrokeWidth + extraPadding;
    const minTileX = tileCoord(bounds.minX - padding, index.tileSize);
    const maxTileX = tileCoord(bounds.maxX + padding, index.tileSize);
    const minTileY = tileCoord(bounds.minY - padding, index.tileSize);
    const maxTileY = tileCoord(bounds.maxY + padding, index.tileSize);
    const candidates: StrokeMeta[] = [];
    const seen = new Set<string>();

    for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
      for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
        const bucket = index.buckets.get(tileKey(tileX, tileY));
        if (!bucket) continue;
        for (const meta of bucket) {
          if (seen.has(meta.id)) continue;
          seen.add(meta.id);
          if (boundsIntersect(meta.bounds, bounds, meta.width + extraPadding)) {
            candidates.push(meta);
          }
        }
      }
    }
    return candidates;
  }

  private strokeMetasAtPoint(
    point: { x: number; y: number },
    radius: number
  ): StrokeMeta[] {
    const index = this.ensureSpatialIndexCache();
    const minTileX = tileCoord(point.x - radius, index.tileSize);
    const maxTileX = tileCoord(point.x + radius, index.tileSize);
    const minTileY = tileCoord(point.y - radius, index.tileSize);
    const maxTileY = tileCoord(point.y + radius, index.tileSize);
    const candidates: StrokeMeta[] = [];
    const seen = new Set<string>();

    for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
      for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
        const bucket = index.buckets.get(tileKey(tileX, tileY));
        if (!bucket) continue;
        for (const meta of bucket) {
          if (seen.has(meta.id)) continue;
          seen.add(meta.id);
          candidates.push(meta);
        }
      }
    }
    return candidates;
  }

  private ensureSpatialIndexCache(): StrokeSpatialIndex {
    if (this.spatialIndexCache) return this.spatialIndexCache;
    const tileSize = STROKE_INDEX_TILE_SIZE;
    const buckets = new Map<string, StrokeMeta[]>();
    let maxStrokeWidth = 0;

    for (const meta of this.ensureVisibleStrokeCache()) {
      maxStrokeWidth = Math.max(maxStrokeWidth, meta.width);
      const minTileX = tileCoord(meta.bounds.minX, tileSize);
      const maxTileX = tileCoord(meta.bounds.maxX, tileSize);
      const minTileY = tileCoord(meta.bounds.minY, tileSize);
      const maxTileY = tileCoord(meta.bounds.maxY, tileSize);
      for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
        for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
          const key = tileKey(tileX, tileY);
          const bucket = buckets.get(key);
          if (bucket) {
            bucket.push(meta);
          } else {
            buckets.set(key, [meta]);
          }
        }
      }
    }

    this.spatialIndexCache = { tileSize, buckets, maxStrokeWidth };
    return this.spatialIndexCache;
  }

  private invalidateVisibleStrokeCache(): void {
    this.visibleStrokeCache = null;
    this.invalidateSpatialIndexCache();
  }

  private invalidateStrokeMapCache(): void {
    this.strokeMapCache = null;
  }

  private invalidateSpatialIndexCache(): void {
    this.spatialIndexCache = null;
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

  translateStrokeSet(ids: Set<string>, dx: number, dy: number): string[] {
    return this.transformStrokeSet(ids, {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: dx,
      f: dy,
      widthScale: 1
    });
  }

  transformStrokeSet(ids: Set<string>, transform: StrokeTransform): string[] {
    if (ids.size === 0) return [];
    const strokeMaps = this.ensureStrokeMapCache();
    const moved: string[] = [];
    for (const id of ids) {
      const stroke = strokeMaps.get(id);
      if (!stroke || stroke.get(FIELD_TOMBSTONED) === true) continue;
      const payload = stroke.get(FIELD_PAYLOAD);
      if (!(payload instanceof Uint8Array)) continue;
      const decoded = decodePayload(payload);
      if (!decoded) continue;
      stroke.set(
        FIELD_PAYLOAD,
        encodePayloadV2({
          color: decoded.color,
          width: sanitizeWidth(decoded.width * transform.widthScale),
          points: decoded.points.map((point) =>
            transformPoint(point, transform)
          )
        })
      );
      moved.push(id);
    }
    if (moved.length > 0) {
      this.invalidateVisibleStrokeCache();
    }
    return moved;
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

function strokeIntersectsLasso(
  stroke: StrokeMeta,
  lasso: Array<{ x: number; y: number }>
): boolean {
  if (lasso.length < 3) return false;
  for (const point of stroke.points) {
    if (pointInPolygon(point, lasso)) return true;
  }
  for (let i = 1; i < stroke.points.length; i += 1) {
    const a = stroke.points[i - 1];
    const b = stroke.points[i];
    for (let j = 0; j < lasso.length; j += 1) {
      const c = lasso[j];
      const d = lasso[(j + 1) % lasso.length];
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

function pointInPolygon(
  point: { x: number; y: number },
  polygon: Array<{ x: number; y: number }>
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function segmentsIntersect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number }
): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);

  if (abC === 0 && pointOnSegment(c, a, b)) return true;
  if (abD === 0 && pointOnSegment(d, a, b)) return true;
  if (cdA === 0 && pointOnSegment(a, c, d)) return true;
  if (cdB === 0 && pointOnSegment(b, c, d)) return true;

  return abC !== abD && cdA !== cdB;
}

function orientation(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number }
): -1 | 0 | 1 {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < 1e-6) return 0;
  return value > 0 ? 1 : -1;
}

function pointOnSegment(
  point: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number }
): boolean {
  return (
    point.x >= Math.min(a.x, b.x) - 1e-6 &&
    point.x <= Math.max(a.x, b.x) + 1e-6 &&
    point.y >= Math.min(a.y, b.y) - 1e-6 &&
    point.y <= Math.max(a.y, b.y) + 1e-6
  );
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

function boundsIntersect(
  a: StrokeBounds,
  b: StrokeBounds,
  padding: number
): boolean {
  return (
    a.maxX + padding >= b.minX &&
    a.minX - padding <= b.maxX &&
    a.maxY + padding >= b.minY &&
    a.minY - padding <= b.maxY
  );
}

function tileCoord(value: number, tileSize: number): number {
  return Math.floor(value / tileSize);
}

function tileKey(x: number, y: number): string {
  return `${x}:${y}`;
}

function applyUndoOp(doc: InkDocument, op: UndoOp): void {
  switch (op.kind) {
    case 'strokeAdded':
      doc.setStrokeTombstoned(op.id, true);
      break;
    case 'eraserDrag':
    case 'clearAll':
    case 'selectionDelete':
      doc.setStrokesTombstoned(op.ids, false);
      break;
    case 'selectionMove':
      doc.translateStrokeSet(new Set(op.ids), -op.dx, -op.dy);
      break;
    case 'selectionTransform':
      doc.transformStrokeSet(new Set(op.ids), op.inverse);
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
    case 'selectionDelete':
      doc.setStrokesTombstoned(op.ids, true);
      break;
    case 'selectionMove':
      doc.translateStrokeSet(new Set(op.ids), op.dx, op.dy);
      break;
    case 'selectionTransform':
      doc.transformStrokeSet(new Set(op.ids), op.transform);
      break;
  }
}

function validTransform(transform: StrokeTransform): boolean {
  return (
    Number.isFinite(transform.a) &&
    Number.isFinite(transform.b) &&
    Number.isFinite(transform.c) &&
    Number.isFinite(transform.d) &&
    Number.isFinite(transform.e) &&
    Number.isFinite(transform.f) &&
    Number.isFinite(transform.widthScale) &&
    transform.widthScale > 0
  );
}

function transformIsIdentity(transform: StrokeTransform): boolean {
  return (
    Math.abs(transform.a - 1) < 0.0001 &&
    Math.abs(transform.b) < 0.0001 &&
    Math.abs(transform.c) < 0.0001 &&
    Math.abs(transform.d - 1) < 0.0001 &&
    Math.abs(transform.e) < 0.001 &&
    Math.abs(transform.f) < 0.001 &&
    Math.abs(transform.widthScale - 1) < 0.0001
  );
}

function invertTransform(transform: StrokeTransform): StrokeTransform | null {
  const det = transform.a * transform.d - transform.b * transform.c;
  if (Math.abs(det) < 1e-8) return null;
  return {
    a: transform.d / det,
    b: -transform.b / det,
    c: -transform.c / det,
    d: transform.a / det,
    e: (transform.c * transform.f - transform.d * transform.e) / det,
    f: (transform.b * transform.e - transform.a * transform.f) / det,
    widthScale: 1 / transform.widthScale
  };
}

function transformPoint(point: InkPoint, transform: StrokeTransform): InkPoint {
  return {
    x: point.x * transform.a + point.y * transform.c + transform.e,
    y: point.x * transform.b + point.y * transform.d + transform.f,
    pressure: point.pressure
  };
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
