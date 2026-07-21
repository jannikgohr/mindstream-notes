/**
 * The Yjs-backed ink document.
 *
 * Strokes live in a shared array of maps so concurrent edits from two
 * devices merge instead of clobbering; tombstones (rather than removals)
 * keep deletes commutative. This module owns that structure and the
 * caches over it — geometry, payload encoding, transforms and undo
 * replay each live in their own sibling module.
 */

import * as Y from 'yjs';
import type { InkPoint } from '$lib/ink/page';
import { sliceStrokeByCircles, type EraserCircle } from '$lib/ink/stroke-slice';
import {
  DEFAULT_COLOR,
  DEFAULT_WIDTH,
  strokeFromMeta,
  type DecodedPayload,
  type InProgressStroke,
  type InkStroke,
  type InkStrokeInput,
  type MutationResult,
  type StrokeBounds,
  type StrokeMeta,
  type StrokeSpatialIndex,
  type StrokeStylePatch,
  type StrokeStyleSnapshot,
  type StrokeTransform,
  type UndoOp
} from './stroke-types';
import {
  boundsContainPoint,
  boundsIntersect,
  boundsOfPoints,
  strokeHitAt,
  strokeIntersectsLasso,
  strokesHitAt,
  tileCoord,
  tileKey
} from './stroke-geometry';
import {
  decodePayload,
  encodePayloadV2,
  randomId,
  sanitizePressure,
  sanitizeWidth,
  sanitizedPoints
} from './stroke-codec';
import {
  invertTransform,
  transformIsIdentity,
  transformPoint,
  validTransform
} from './stroke-transform';
import { applyRedoOp, applyUndoOp } from './document-undo';

const STROKES_KEY = 'strokes';
const FIELD_ID = 'id';
const FIELD_TOMBSTONED = 'tombstoned';
const FIELD_PAYLOAD = 'payload';
const STROKE_INDEX_TILE_SIZE = 512;

// Re-exported so existing importers keep reaching everything ink-document
// related through this module.
export {
  DEFAULT_COLOR,
  DEFAULT_WIDTH,
  type InkStroke,
  type InkStrokeInput,
  type MutationResult,
  type StrokeBounds,
  type StrokeStylePatch,
  type StrokeStyleSnapshot,
  type StrokeTransform,
  type UndoOp
} from './stroke-types';
export { strokesHitAt } from './stroke-geometry';

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

  addStrokes(strokes: Iterable<InkStrokeInput>): MutationResult<string[]> {
    return this.transactLocalUpdate(() => {
      const added: string[] = [];
      for (const input of strokes) {
        const points = sanitizedPoints(input.points);
        if (points.length === 0) continue;
        const id = `stroke_${randomId()}`;
        const map = new Y.Map<unknown>();
        map.set(FIELD_ID, id);
        map.set(FIELD_TOMBSTONED, false);
        map.set(
          FIELD_PAYLOAD,
          encodePayloadV2({
            color: input.color >>> 0,
            width: sanitizeWidth(input.width),
            points
          })
        );
        this.strokes.push([map]);
        this.strokeMapCache?.set(id, map);
        added.push(id);
      }
      if (added.length > 0) {
        this.invalidateVisibleStrokeCache();
        this.recordOp({ kind: 'strokesAdded', ids: added });
      }
      return added;
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

  styleStrokes(
    ids: Iterable<string>,
    patch: StrokeStylePatch
  ): MutationResult<string[]> {
    const hasColor = Number.isFinite(patch.color);
    const hasWidth = Number.isFinite(patch.width);
    if (!hasColor && !hasWidth) {
      return { value: [], update: null };
    }
    return this.transactLocalUpdate(() => {
      const { changed, before, after } = this.styleStrokeSet(
        new Set(ids),
        patch
      );
      if (changed.length > 0) {
        this.recordOp({ kind: 'selectionStyle', before, after });
      }
      return changed;
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

  /**
   * Partial ("true") eraser: for every stroke the eraser passes over, remove
   * the covered portions and replace the stroke with the surviving fragments.
   * Records no undo op (call `finishSliceErase` once at the end of the drag,
   * mirroring `eraseAtMany` + `finishEraserDrag`) so a swipe undoes as one
   * step. Returns the ids tombstoned and the fragment ids created this batch.
   */
  sliceAtMany(
    points: Array<{ x: number; y: number }>,
    radius: number
  ): MutationResult<{ removed: string[]; added: string[] }> {
    const empty = { value: { removed: [], added: [] }, update: null };
    if (!(radius > 0)) return empty;
    const circles: EraserCircle[] = [];
    for (const point of points) {
      if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
        circles.push({ x: point.x, y: point.y, r: radius });
      }
    }
    if (circles.length === 0) return empty;

    // Strokes whose path the eraser actually touches this batch.
    const targets = new Map<string, StrokeMeta>();
    for (const circle of circles) {
      for (const meta of this.strokeMetasAtPoint(circle, radius)) {
        if (targets.has(meta.id)) continue;
        if (strokeHitAt(meta, circle, radius)) targets.set(meta.id, meta);
      }
    }
    if (targets.size === 0) return empty;

    return this.transactLocalUpdate(() => {
      const removed: string[] = [];
      const added: string[] = [];
      const strokeMaps = this.ensureStrokeMapCache();
      for (const [id, meta] of targets) {
        const map = strokeMaps.get(id);
        if (!map || map.get(FIELD_TOMBSTONED) === true) continue;
        const { changed, fragments } = sliceStrokeByCircles(
          meta.points,
          circles
        );
        if (!changed) continue;
        map.set(FIELD_TOMBSTONED, true);
        removed.push(id);
        for (const fragment of fragments) {
          const points = sanitizedPoints(fragment);
          if (points.length < 2) continue;
          const newId = `stroke_${randomId()}`;
          const newMap = new Y.Map<unknown>();
          newMap.set(FIELD_ID, newId);
          newMap.set(FIELD_TOMBSTONED, false);
          newMap.set(
            FIELD_PAYLOAD,
            encodePayloadV2({
              color: meta.color,
              width: meta.width,
              points
            })
          );
          this.strokes.push([newMap]);
          strokeMaps.set(newId, newMap);
          added.push(newId);
        }
      }
      if (removed.length > 0 || added.length > 0) {
        this.invalidateVisibleStrokeCache();
      }
      return { removed, added };
    });
  }

  /**
   * Close out a partial-erase drag as a single undo step. `added` is every
   * fragment created during the drag, `removed` every stroke tombstoned.
   * Fragments that were themselves re-erased mid-drag are added-and-removed
   * and must not reappear on redo, so they are excluded from `finalFragments`.
   */
  finishSliceErase(added: Iterable<string>, removed: Iterable<string>): void {
    const addedSet = new Set(added);
    const removedSet = new Set(removed);
    const removedOriginals = [...removedSet]
      .filter((id) => !addedSet.has(id))
      .sort();
    const addedFragments = [...addedSet].sort();
    const finalFragments = addedFragments.filter((id) => !removedSet.has(id));
    if (removedOriginals.length === 0 && addedFragments.length === 0) return;
    this.recordOp({
      kind: 'strokeSlice',
      removedOriginals,
      addedFragments,
      finalFragments
    });
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

  /**
   * Drop the local undo/redo stacks. Used after a history-version restore so
   * the coarse "replace the whole page" restore doesn't sit on the per-stroke
   * undo stack (a restore is reversed through history, not Ctrl+Z). Mirrors how
   * `applyRemoteUpdate` clears history when a peer's edit lands.
   */
  resetUndoHistory(): void {
    this.undo.length = 0;
    this.redo.length = 0;
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

  styleStrokeSet(
    ids: Set<string>,
    patch: StrokeStylePatch
  ): {
    changed: string[];
    before: StrokeStyleSnapshot[];
    after: StrokeStyleSnapshot[];
  } {
    if (ids.size === 0) return { changed: [], before: [], after: [] };
    const strokeMaps = this.ensureStrokeMapCache();
    const changed: string[] = [];
    const before: StrokeStyleSnapshot[] = [];
    const after: StrokeStyleSnapshot[] = [];
    const hasColor = Number.isFinite(patch.color);
    const hasWidth = Number.isFinite(patch.width);
    const color = hasColor ? (patch.color ?? DEFAULT_COLOR) >>> 0 : null;
    const width = hasWidth ? sanitizeWidth(patch.width ?? DEFAULT_WIDTH) : null;

    for (const id of ids) {
      const stroke = strokeMaps.get(id);
      if (!stroke || stroke.get(FIELD_TOMBSTONED) === true) continue;
      const payload = stroke.get(FIELD_PAYLOAD);
      if (!(payload instanceof Uint8Array)) continue;
      const decoded = decodePayload(payload);
      if (!decoded) continue;
      const nextColor = color ?? decoded.color;
      const nextWidth = width ?? decoded.width;
      if (
        nextColor === decoded.color &&
        Math.abs(nextWidth - decoded.width) < 0.001
      ) {
        continue;
      }
      before.push({ id, color: decoded.color, width: decoded.width });
      after.push({ id, color: nextColor, width: nextWidth });
      stroke.set(
        FIELD_PAYLOAD,
        encodePayloadV2({
          color: nextColor,
          width: nextWidth,
          points: decoded.points
        })
      );
      changed.push(id);
    }
    if (changed.length > 0) {
      this.invalidateVisibleStrokeCache();
    }
    return { changed, before, after };
  }

  applyStrokeStyleSnapshot(styles: StrokeStyleSnapshot[]): string[] {
    if (styles.length === 0) return [];
    const styleById = new Map(styles.map((style) => [style.id, style]));
    const strokeMaps = this.ensureStrokeMapCache();
    const changed: string[] = [];
    for (const [id, style] of styleById) {
      const stroke = strokeMaps.get(id);
      if (!stroke || stroke.get(FIELD_TOMBSTONED) === true) continue;
      const payload = stroke.get(FIELD_PAYLOAD);
      if (!(payload instanceof Uint8Array)) continue;
      const decoded = decodePayload(payload);
      if (!decoded) continue;
      stroke.set(
        FIELD_PAYLOAD,
        encodePayloadV2({
          color: style.color >>> 0,
          width: sanitizeWidth(style.width),
          points: decoded.points
        })
      );
      changed.push(id);
    }
    if (changed.length > 0) {
      this.invalidateVisibleStrokeCache();
    }
    return changed;
  }
}
