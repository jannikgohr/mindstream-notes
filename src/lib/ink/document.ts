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
import { sliceStrokeByCircles, type EraserCircle } from '$lib/ink/stroke-slice';
import {
  DEFAULT_COLOR,
  DEFAULT_WIDTH,
  strokeFromMeta,
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
  boundsIntersect,
  boundsOfPoints,
  strokeHitAt,
  strokeIntersectsLasso,
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
import {
  defaultLayout,
  DEFAULT_PAGE,
  layoutForPages,
  pageCountForContentMaxY,
  pageIndexAt,
  pageRect,
  type InkPage,
  type DocumentLayout
} from './page';
import {
  readPages,
  legacyPages,
  pageOffset,
  clipPoints,
  INK_PAGES,
  INK_PAGE_ORDER,
  INK_DELETED_PAGES,
  INK_META,
  INK_SCHEMA
} from './page-document';

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
  private pageOffsetsCache: Map<string, { x: number; y: number }> | null = null;
  readonly undo: UndoOp[] = [];
  readonly redo: UndoOp[] = [];

  constructor(doc = new Y.Doc()) {
    this.doc = doc;
    this.strokes = doc.getArray<Y.Map<unknown>>(STROKES_KEY);
    const version = doc.getMap<number>(INK_META).get('schema') ?? 0;
    if (version > INK_SCHEMA)
      throw new Error('This ink document requires a newer app version.');
  }

  hasPages(): boolean {
    return this.doc.getMap<InkPage>(INK_PAGES).size > 0;
  }

  pages(): InkPage[] {
    return this.hasPages()
      ? readPages(this.doc)
      : legacyPages(pageCountForContentMaxY(this.contentMaxY()));
  }

  layout(): DocumentLayout {
    return this.hasPages()
      ? layoutForPages(readPages(this.doc))
      : defaultLayout(pageCountForContentMaxY(this.contentMaxY()));
  }

  private ensurePages(): void {
    if (this.hasPages()) return;
    const pages = this.pages();
    this.restorePages(pages);
    const layout = layoutForPages(pages);
    for (const map of this.strokes.toArray()) {
      const bytes = map.get(FIELD_PAYLOAD);
      const id = map.get(FIELD_ID);
      if (!(bytes instanceof Uint8Array) || typeof id !== 'string') continue;
      const data = decodePayload(bytes);
      if (!data) continue;
      let first = true;
      for (let i = 0; i < pages.length; i++) {
        const rect = pageRect(layout, i)!;
        const fragments = clipPoints(data.points, rect);
        for (let j = 0; j < fragments.length; j++) {
          const target = first ? map : new Y.Map<unknown>();
          if (!first) {
            target.set(FIELD_ID, `${id}:page:${i}:${j}`);
            target.set(FIELD_TOMBSTONED, map.get(FIELD_TOMBSTONED) === true);
            this.strokes.push([target]);
          }
          target.set('pageId', pages[i].id);
          target.set(
            FIELD_PAYLOAD,
            encodePayloadV2({
              ...data,
              points: fragments[j].map((p) => ({
                ...p,
                x: p.x - rect[0],
                y: p.y - rect[1]
              }))
            })
          );
          first = false;
        }
      }
    }
    this.invalidateStrokeMapCache();
    this.invalidateVisibleStrokeCache();
    this.resetUndoHistory();
  }

  /** Keep ordinary ink notes open-ended after page management materializes them. */
  private appendTrailingBlankPage(): void {
    if (!this.hasPages()) return;
    const pages = readPages(this.doc);
    if (pages.some((page) => page.background)) return;
    const last = pages.at(-1);
    if (
      !last ||
      !this.strokes
        .toArray()
        .some(
          (stroke) =>
            stroke.get('pageId') === last.id &&
            stroke.get(FIELD_TOMBSTONED) !== true
        )
    )
      return;
    const records = this.doc.getMap<InkPage>(INK_PAGES);
    // Peers writing on the same final page choose the same unused identity.
    // Count retained records too, so deleting a page never revives its strokes.
    let index = records.size;
    while (records.has(`auto-blank-${index}`)) index++;
    const id = `auto-blank-${index}`;
    records.set(id, { id, ...DEFAULT_PAGE });
    this.doc.getMap<boolean>(INK_DELETED_PAGES).set(id, false);
    const order = this.doc.getMap<number>(INK_PAGE_ORDER);
    order.set(id, (order.get(last.id) ?? pages.length - 1) + 1);
    this.invalidateVisibleStrokeCache();
  }

  /** Page identities and deletion flags are separate from order: concurrent moves cannot resurrect a deleted page. */
  restorePages(pages: InkPage[]): void {
    const records = this.doc.getMap<InkPage>(INK_PAGES);
    const deleted = this.doc.getMap<boolean>(INK_DELETED_PAGES);
    const order = this.doc.getMap<number>(INK_PAGE_ORDER);
    const ids = new Set(pages.map((p) => p.id));
    for (const id of records.keys()) if (!ids.has(id)) deleted.set(id, true);
    pages.forEach((page, index) => {
      if (JSON.stringify(records.get(page.id)) !== JSON.stringify(page))
        records.set(page.id, page);
      deleted.set(page.id, false);
      order.set(page.id, index);
    });
    this.doc.getMap<number>(INK_META).set('schema', INK_SCHEMA);
    this.invalidateVisibleStrokeCache();
  }

  insertPages(
    pages: InkPage[],
    at = this.pages().length
  ): MutationResult<string[]> {
    return this.transactLocalUpdate(() => {
      this.ensurePages();
      const before = this.pages();
      const index = Math.max(0, Math.min(before.length, at));
      const after = [
        ...before.slice(0, index),
        ...pages,
        ...before.slice(index)
      ];
      this.restorePages(after);
      this.recordOp({ kind: 'pages', before, after });
      return pages.map((p) => p.id);
    });
  }

  movePage(id: string, to: number): MutationResult<boolean> {
    return this.transactLocalUpdate(() => {
      this.ensurePages();
      const before = this.pages();
      const page = before.find((p) => p.id === id);
      if (!page || to < 0 || to >= before.length) return false;
      const after = before.filter((p) => p.id !== id);
      after.splice(to, 0, page);
      // Change only this page's order. Simultaneous moves of different pages merge.
      const order = this.doc.getMap<number>(INK_PAGE_ORDER);
      const left =
        to > 0
          ? (order.get(after[to - 1].id) ?? to - 1)
          : (order.get(after[1]?.id) ?? 0) - 2;
      const right =
        to < after.length - 1
          ? (order.get(after[to + 1].id) ?? to + 1)
          : left + 2;
      order.set(id, (left + right) / 2);
      this.invalidateVisibleStrokeCache();
      this.recordOp({ kind: 'pages', before, after });
      return true;
    });
  }

  deletePage(id: string): MutationResult<boolean> {
    return this.transactLocalUpdate(() => {
      this.ensurePages();
      const before = this.pages();
      if (before.length <= 1 || !before.some((p) => p.id === id)) return false;
      this.doc.getMap<boolean>(INK_DELETED_PAGES).set(id, true);
      this.invalidateVisibleStrokeCache();
      this.recordOp({ kind: 'pages', before, after: this.pages() });
      return true;
    });
  }

  restoreSnapshot(snapshot: InkDocument): MutationResult<void> {
    return this.transactLocalUpdate(() => {
      for (const key of ['pdf_annotations', 'pdf_form_values']) {
        const target = this.doc.getMap(key),
          source = snapshot.doc.getMap(key);
        if (target.size || source.size) {
          target.clear();
          for (const [id, value] of source)
            target.set(id, structuredClone(value));
        }
      }
      this.clearAll();
      if (snapshot.hasPages() || this.hasPages())
        this.restorePages(snapshot.pages());
      this.addStrokes(
        snapshot
          .visibleStrokes()
          .map(({ color, width, points }) => ({ color, width, points }))
      );
      this.resetUndoHistory();
    });
  }

  private globalPayload(map: Y.Map<unknown>) {
    const payload = map.get(FIELD_PAYLOAD);
    if (!(payload instanceof Uint8Array)) return null;
    const decoded = decodePayload(payload);
    if (!decoded) return null;
    const pageId = map.get('pageId');
    if (typeof pageId !== 'string') return decoded;
    if (!this.pageOffsetsCache) {
      const pages = readPages(this.doc);
      const width = Math.max(0, ...pages.map((p) => p.width));
      let y = 0;
      this.pageOffsetsCache = new Map(
        pages.map((page) => {
          const result: [string, { x: number; y: number }] = [
            page.id,
            { x: (width - page.width) / 2, y }
          ];
          y += page.height + defaultLayout().pageGap;
          return result;
        })
      );
    }
    const offset = this.pageOffsetsCache.get(pageId);
    if (!offset) return null;
    return {
      ...decoded,
      points: decoded.points.map((p) => ({
        ...p,
        x: p.x + offset.x,
        y: p.y + offset.y
      }))
    };
  }

  private writePayload(map: Y.Map<unknown>, data: InProgressStroke): void {
    if (!this.hasPages()) {
      map.set(FIELD_PAYLOAD, encodePayloadV2(data));
      return;
    }
    const pages = readPages(this.doc);
    const layout = layoutForPages(pages);
    const point = data.points[Math.floor(data.points.length / 2)];
    const index = point ? pageIndexAt(layout, point.x, point.y) : null;
    const page =
      index !== null
        ? pages[index]
        : (pages.find((p) => p.id === map.get('pageId')) ?? pages[0]);
    if (!page) return;
    const offset = pageOffset(pages, page.id)!;
    map.set('pageId', page.id);
    map.set(
      FIELD_PAYLOAD,
      encodePayloadV2({
        ...data,
        points: data.points.map((p) => ({
          ...p,
          x: p.x - offset.x,
          y: p.y - offset.y
        }))
      })
    );
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
    let value!: T;
    this.doc.transact(() => {
      value = fn();
    });
    const update = Y.encodeStateAsUpdate(this.doc, before);
    return {
      value,
      update: update.byteLength > 2 ? update : null
    };
  }

  visibleStrokes(): InkStroke[] {
    return this.ensureVisibleStrokeCache().map(strokeFromMeta);
  }

  pageStrokes(pageId: string): InkStroke[] {
    const offset = pageOffset(this.pages(), pageId);
    if (!offset) return [];
    return this.visibleStrokes()
      .filter((s) => this.findStrokeMap(s.id)?.get('pageId') === pageId)
      .map((s) => ({
        ...s,
        points: s.points.map((p) => ({
          ...p,
          x: p.x - offset.x,
          y: p.y - offset.y
        }))
      }));
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
      this.writePayload(map, stroke);
      this.strokes.push([map]);
      this.strokeMapCache?.set(id, map);
      this.invalidateVisibleStrokeCache();
      this.appendTrailingBlankPage();
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
        const id = input.id ?? `stroke_${randomId()}`;
        if (this.ensureStrokeMapCache().has(id)) continue;
        const map = new Y.Map<unknown>();
        map.set(FIELD_ID, id);
        map.set(FIELD_TOMBSTONED, false);
        this.writePayload(map, {
          color: input.color >>> 0,
          width: sanitizeWidth(input.width),
          points
        });
        this.strokes.push([map]);
        this.strokeMapCache?.set(id, map);
        added.push(id);
      }
      if (added.length > 0) {
        this.invalidateVisibleStrokeCache();
        this.appendTrailingBlankPage();
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
          this.writePayload(newMap, {
            color: meta.color,
            width: meta.width,
            points
          });
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
    for (const stroke of this.ensureStrokeMapCache().values()) {
      if (stroke.get(FIELD_TOMBSTONED) === true) continue;
      const id = stroke.get(FIELD_ID);
      const payload = stroke.get(FIELD_PAYLOAD);
      if (typeof id !== 'string' || !(payload instanceof Uint8Array)) {
        continue;
      }
      const decoded = this.globalPayload(stroke);
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
    this.pageOffsetsCache = null;
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
      const decoded = this.globalPayload(stroke);
      if (!decoded) continue;
      this.writePayload(stroke, {
        color: decoded.color,
        width: sanitizeWidth(decoded.width * transform.widthScale),
        points: decoded.points.map((point) => transformPoint(point, transform))
      });
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
