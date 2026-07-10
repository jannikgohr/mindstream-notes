import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  DEFAULT_COLOR,
  DEFAULT_WIDTH,
  InkDocument,
  strokesHitAt
} from './document';
import { pageCountForContentMaxY, pointToSegmentDistanceSq } from './page';

function pointPairs(doc: InkDocument): number[][] {
  return doc
    .visibleStrokes()
    .map((stroke) => stroke.points.flatMap((p) => [p.x, p.y]));
}

describe('InkDocument', () => {
  it('round-trips an empty document', () => {
    const doc = new InkDocument();
    const restored = InkDocument.fromBytes(doc.encode());

    expect(restored.visibleStrokes()).toEqual([]);
  });

  it('stores stroke geometry, pressure, color, and width', () => {
    const doc = new InkDocument();
    doc.beginStroke(0xff0066ff, 7.25);
    doc.pushPoint(1, 2, 0.25);
    doc.pushPoint(3, 4, 0.5);
    const { value: id } = doc.endStroke();

    const restored = InkDocument.fromBytes(doc.encode());
    const [stroke] = restored.visibleStrokes();

    expect(id).toMatch(/^stroke_/);
    expect(stroke.color).toBe(0xff0066ff);
    expect(stroke.width).toBeCloseTo(7.25);
    expect(stroke.points).toEqual([
      { x: 1, y: 2, pressure: 0.25 },
      { x: 3, y: 4, pressure: 0.5 }
    ]);
  });

  it('keeps concurrent stroke additions convergent', () => {
    const base = new InkDocument();
    base.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    base.pushPoint(0, 0, 1);
    base.endStroke();
    const baseBytes = base.encode();

    const a = InkDocument.fromBytes(baseBytes);
    a.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    a.pushPoint(1, 1, 1);
    a.endStroke();

    const b = InkDocument.fromBytes(baseBytes);
    b.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    b.pushPoint(2, 2, 1);
    b.endStroke();

    const mergedAB = InkDocument.fromBytes(a.encode());
    expect(mergedAB.applyRemoteUpdate(b.encode())).toBe(true);
    const mergedBA = InkDocument.fromBytes(b.encode());
    expect(mergedBA.applyRemoteUpdate(a.encode())).toBe(true);

    expect(pointPairs(mergedAB)).toEqual(pointPairs(mergedBA));
    expect(mergedAB.visibleStrokes()).toHaveLength(3);
  });

  it('exports state vectors and diffs for collab handshakes', () => {
    const a = new InkDocument();
    const b = new InkDocument();
    a.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    a.pushPoint(10, 20, 1);
    a.endStroke();

    const diff = a.encodeDiffForStateVector(b.encodeStateVector());
    expect(b.applyRemoteUpdate(diff)).toBe(true);

    expect(pointPairs(b)).toEqual([[10, 20]]);
  });

  it('undoes and redoes stroke additions', () => {
    const doc = new InkDocument();
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(1, 1, 1);
    doc.endStroke();

    expect(doc.visibleStrokes()).toHaveLength(1);
    expect(doc.undoLast().value).toBe(true);
    expect(doc.visibleStrokes()).toHaveLength(0);
    expect(doc.redoLast().value).toBe(true);
    expect(doc.visibleStrokes()).toHaveLength(1);
  });

  it('clears undo and redo stacks after a history restore', () => {
    const doc = new InkDocument();
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(1, 1, 1);
    doc.endStroke();
    doc.undoLast();

    doc.resetUndoHistory();

    expect(doc.undoLast().value).toBe(false);
    expect(doc.redoLast().value).toBe(false);
  });

  it('records eraser drags as one undoable operation', () => {
    const doc = new InkDocument();
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(0, 0, 1);
    doc.pushPoint(10, 0, 1);
    const first = doc.endStroke().value;
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(100, 100, 1);
    doc.pushPoint(110, 100, 1);
    doc.endStroke();

    const erased = doc.eraseAt({ x: 5, y: 1 }, 3).value;
    doc.finishEraserDrag(erased);

    expect(erased).toEqual([first]);
    expect(doc.visibleStrokes()).toHaveLength(1);
    expect(doc.undoLast().value).toBe(true);
    expect(doc.visibleStrokes()).toHaveLength(2);
  });

  it('erases multiple samples in one batch and ignores prior drag hits', () => {
    const doc = new InkDocument();
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(0, 0, 1);
    doc.pushPoint(10, 0, 1);
    const first = doc.endStroke().value;
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(100, 0, 1);
    doc.pushPoint(110, 0, 1);
    const second = doc.endStroke().value;
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(200, 0, 1);
    doc.pushPoint(210, 0, 1);
    doc.endStroke();
    if (!first || !second) throw new Error('expected committed strokes');

    const { value: erased, update } = doc.eraseAtMany(
      [
        { x: 5, y: 1 },
        { x: 105, y: 1 },
        { x: 5, y: 1 }
      ],
      3
    );

    expect(new Set(erased)).toEqual(new Set([first, second]));
    expect(update).toBeInstanceOf(Uint8Array);
    expect(doc.visibleStrokes()).toHaveLength(1);

    const again = doc.eraseAtMany([{ x: 105, y: 1 }], 3, erased);
    expect(again.value).toEqual([]);
    expect(again.update).toBeNull();
  });

  it('erases strokes across spatial index tile boundaries', () => {
    const doc = new InkDocument();
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(514, 10, 1);
    doc.pushPoint(530, 10, 1);
    const id = doc.endStroke().value;
    if (!id) throw new Error('expected committed stroke');

    expect(doc.eraseAt({ x: 511, y: 10 }, 5).value).toEqual([id]);
    expect(doc.visibleStrokes()).toHaveLength(0);
  });

  it('returns only strokes intersecting a viewport bounds query', () => {
    const doc = new InkDocument();
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(10, 10, 1);
    doc.pushPoint(20, 10, 1);
    const visible = doc.endStroke().value;
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(2000, 2000, 1);
    doc.pushPoint(2010, 2000, 1);
    doc.endStroke();
    if (!visible) throw new Error('expected committed stroke');

    expect(
      doc
        .visibleStrokesInBounds({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 2)
        .map((stroke) => stroke.id)
    ).toEqual([visible]);
  });

  it('clears visible strokes and restores exactly those on undo', () => {
    const doc = new InkDocument();
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(0, 0, 1);
    const first = doc.endStroke().value;
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(1, 1, 1);
    const second = doc.endStroke().value;
    if (!first || !second) throw new Error('expected committed strokes');

    doc.setStrokeTombstoned(second, true);
    expect(doc.clearAll().value).toEqual([first]);
    expect(doc.visibleStrokes()).toHaveLength(0);
    expect(doc.undoLast().value).toBe(true);
    expect(doc.visibleStrokes().map((s) => s.id)).toEqual([first]);
  });

  it('selects strokes that intersect a lasso path', () => {
    const doc = new InkDocument();
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(10, 10, 1);
    doc.pushPoint(50, 10, 1);
    const inside = doc.endStroke().value;
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(-10, 60, 1);
    doc.pushPoint(130, 60, 1);
    const crossing = doc.endStroke().value;
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(250, 250, 1);
    doc.pushPoint(260, 250, 1);
    doc.endStroke();
    if (!inside || !crossing) throw new Error('expected committed strokes');

    const ids = doc.strokeIdsInLasso([
      { x: 0, y: 0 },
      { x: 120, y: 0 },
      { x: 120, y: 120 },
      { x: 0, y: 120 }
    ]);

    expect(new Set(ids)).toEqual(new Set([inside, crossing]));
  });

  it('selects strokes that lie exactly on a lasso edge', () => {
    const doc = new InkDocument();
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(-10, 0, 1);
    doc.pushPoint(110, 0, 1);
    const edge = doc.endStroke().value;
    if (!edge) throw new Error('expected committed stroke');

    const ids = doc.strokeIdsInLasso([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 20 },
      { x: 0, y: 20 }
    ]);

    expect(ids).toContain(edge);
  });

  it('returns no lasso hits when the polygon misses every stroke', () => {
    const doc = new InkDocument();
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(10, 10, 1);
    doc.pushPoint(15, 10, 1);
    doc.endStroke();

    expect(
      doc.strokeIdsInLasso([
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 5 },
        { x: 5, y: 5 },
        { x: 5, y: 20 },
        { x: 0, y: 20 }
      ])
    ).toEqual([]);
  });

  it('returns an empty update when the eraser misses every stroke', () => {
    const doc = new InkDocument();
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(100, 100, 1);
    doc.pushPoint(110, 100, 1);
    doc.endStroke();

    expect(doc.eraseAt({ x: 0, y: 0 }, 5).value).toEqual([]);
    expect(doc.visibleStrokes()).toHaveLength(1);
  });

  it('keeps selection styling as a no-op when the stroke already matches', () => {
    const doc = new InkDocument();
    doc.beginStroke(DEFAULT_COLOR, 4);
    doc.pushPoint(0, 0, 1);
    doc.pushPoint(10, 0, 1);
    const first = doc.endStroke().value;
    if (!first) throw new Error('expected committed stroke');

    expect(
      doc.styleStrokes([first], { color: DEFAULT_COLOR, width: 4 }).value
    ).toEqual([]);
  });

  it('returns no hit when a point stays inside a stroke bounds box but away from every segment', () => {
    const strokes = [
      {
        id: 'stroke_box',
        color: DEFAULT_COLOR,
        width: DEFAULT_WIDTH,
        points: [
          { x: 0, y: 0, pressure: 1 },
          { x: 10, y: 0, pressure: 1 },
          { x: 10, y: 10, pressure: 1 }
        ],
        bounds: {
          minX: 0,
          minY: 0,
          maxX: 10,
          maxY: 10
        }
      }
    ];

    expect(strokesHitAt(strokes, { x: 5, y: 5 }, 1)).toEqual([]);
  });

  it('treats an empty decoded stroke as zero-sized bounds', () => {
    const ydoc = new Y.Doc();
    const strokes = ydoc.getArray<Y.Map<unknown>>('strokes');
    const stroke = new Y.Map<unknown>();
    stroke.set('id', 'stroke_empty');
    stroke.set('tombstoned', false);
    stroke.set('payload', buildPayload(0xff112233, 2.5, [], []));
    strokes.push([stroke]);

    const doc = InkDocument.fromBytes(Y.encodeStateAsUpdate(ydoc));
    const [decoded] = doc.visibleStrokes();

    expect(decoded.bounds).toEqual({
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0
    });
    expect(doc.contentMaxY()).toBe(0);
  });

  it('deletes selected strokes as one undoable operation', () => {
    const doc = new InkDocument();
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(0, 0, 1);
    doc.pushPoint(10, 0, 1);
    const first = doc.endStroke().value;
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(100, 100, 1);
    doc.pushPoint(110, 100, 1);
    const second = doc.endStroke().value;
    if (!first || !second) throw new Error('expected committed strokes');

    expect(doc.deleteStrokes([first]).value).toEqual([first]);
    expect(doc.visibleStrokes().map((s) => s.id)).toEqual([second]);
    expect(doc.undoLast().value).toBe(true);
    expect(new Set(doc.visibleStrokes().map((s) => s.id))).toEqual(
      new Set([first, second])
    );
    expect(doc.redoLast().value).toBe(true);
    expect(doc.visibleStrokes().map((s) => s.id)).toEqual([second]);
  });

  it('moves selected strokes as one undoable operation', () => {
    const doc = new InkDocument();
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(0, 0, 0.5);
    doc.pushPoint(10, 0, 1);
    const first = doc.endStroke().value;
    doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
    doc.pushPoint(100, 100, 1);
    doc.pushPoint(110, 100, 1);
    doc.endStroke();
    if (!first) throw new Error('expected committed stroke');

    expect(doc.translateStrokes([first], 25, 40).value).toEqual([first]);
    expect(doc.visibleStrokes()[0].points).toEqual([
      { x: 25, y: 40, pressure: 0.5 },
      { x: 35, y: 40, pressure: 1 }
    ]);
    expect(doc.undoLast().value).toBe(true);
    expect(doc.visibleStrokes()[0].points).toEqual([
      { x: 0, y: 0, pressure: 0.5 },
      { x: 10, y: 0, pressure: 1 }
    ]);
    expect(doc.redoLast().value).toBe(true);
    expect(doc.visibleStrokes()[0].points).toEqual([
      { x: 25, y: 40, pressure: 0.5 },
      { x: 35, y: 40, pressure: 1 }
    ]);
  });

  it('transforms selected strokes as one undoable operation', () => {
    const doc = new InkDocument();
    doc.beginStroke(DEFAULT_COLOR, 4);
    doc.pushPoint(10, 0, 0.5);
    doc.pushPoint(20, 0, 1);
    const first = doc.endStroke().value;
    if (!first) throw new Error('expected committed stroke');

    const transform = {
      a: 0,
      b: 2,
      c: -2,
      d: 0,
      e: 0,
      f: 0,
      widthScale: 2
    };

    expect(doc.transformStrokes([first], transform).value).toEqual([first]);
    expect(doc.visibleStrokes()[0].width).toBeCloseTo(8);
    expect(doc.visibleStrokes()[0].points).toEqual([
      { x: 0, y: 20, pressure: 0.5 },
      { x: 0, y: 40, pressure: 1 }
    ]);
    expect(doc.undoLast().value).toBe(true);
    expect(doc.visibleStrokes()[0].width).toBeCloseTo(4);
    expect(doc.visibleStrokes()[0].points).toEqual([
      { x: 10, y: 0, pressure: 0.5 },
      { x: 20, y: 0, pressure: 1 }
    ]);
    expect(doc.redoLast().value).toBe(true);
    expect(doc.visibleStrokes()[0].width).toBeCloseTo(8);
  });

  it('adds pasted strokes as one undoable operation', () => {
    const doc = new InkDocument();

    const { value: ids } = doc.addStrokes([
      {
        color: 0xff336699,
        width: 5,
        points: [
          { x: 10, y: 20, pressure: 0.5 },
          { x: 30, y: 40, pressure: 1 }
        ]
      },
      {
        color: 0xffaa5500,
        width: 2,
        points: [
          { x: 50, y: 60, pressure: 1 },
          { x: 70, y: 80, pressure: 1 }
        ]
      }
    ]);

    expect(ids).toHaveLength(2);
    expect(doc.visibleStrokes()).toHaveLength(2);
    expect(doc.visibleStrokes()[0]).toMatchObject({
      color: 0xff336699,
      width: 5
    });
    expect(doc.undoLast().value).toBe(true);
    expect(doc.visibleStrokes()).toHaveLength(0);
    expect(doc.redoLast().value).toBe(true);
    expect(doc.visibleStrokes().map((stroke) => stroke.id)).toEqual(ids);
  });

  it('restyles selected strokes as one undoable operation', () => {
    const doc = new InkDocument();
    doc.beginStroke(DEFAULT_COLOR, 4);
    doc.pushPoint(0, 0, 1);
    doc.pushPoint(10, 0, 1);
    const first = doc.endStroke().value;
    doc.beginStroke(0xff112233, 2);
    doc.pushPoint(100, 100, 1);
    doc.pushPoint(110, 100, 1);
    doc.endStroke();
    if (!first) throw new Error('expected committed stroke');

    expect(
      doc.styleStrokes([first], { color: 0xffabcdef, width: 8 }).value
    ).toEqual([first]);
    expect(doc.visibleStrokes()[0]).toMatchObject({
      color: 0xffabcdef,
      width: 8
    });
    expect(doc.visibleStrokes()[1]).toMatchObject({
      color: 0xff112233,
      width: 2
    });
    expect(doc.undoLast().value).toBe(true);
    expect(doc.visibleStrokes()[0]).toMatchObject({
      color: DEFAULT_COLOR,
      width: 4
    });
    expect(doc.redoLast().value).toBe(true);
    expect(doc.visibleStrokes()[0]).toMatchObject({
      color: 0xffabcdef,
      width: 8
    });
  });

  it('rejects malformed remote updates', () => {
    const doc = new InkDocument();

    expect(doc.applyRemoteUpdate(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('can read Yjs updates containing the expected stroke shape', () => {
    const ydoc = new Y.Doc();
    const strokes = ydoc.getArray<Y.Map<unknown>>('strokes');
    const stroke = new Y.Map<unknown>();
    stroke.set('id', 'stroke_manual');
    stroke.set('tombstoned', false);
    stroke.set(
      'payload',
      buildPayload(0xff112233, 2.5, [1, 2, 3, 4], [0.5, 1])
    );
    strokes.push([stroke]);

    const doc = InkDocument.fromBytes(Y.encodeStateAsUpdate(ydoc));
    const [decoded] = doc.visibleStrokes();

    expect(decoded.id).toBe('stroke_manual');
    expect(decoded.color).toBe(0xff112233);
    expect(decoded.width).toBeCloseTo(2.5);
    expect(decoded.points).toEqual([
      { x: 1, y: 2, pressure: 0.5 },
      { x: 3, y: 4, pressure: 1 }
    ]);
  });

  it('drops malformed v1 and v2 payloads instead of decoding garbage', () => {
    const ydoc = new Y.Doc();
    const strokes = ydoc.getArray<Y.Map<unknown>>('strokes');

    for (const [id, payload] of [
      ['stroke_bad_v1', new Uint8Array([1, 0, 0, 0, 0, 1, 0, 0, 0])],
      ['stroke_bad_v2', new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0])]
    ] as const) {
      const stroke = new Y.Map<unknown>();
      stroke.set('id', id);
      stroke.set('tombstoned', false);
      stroke.set('payload', payload);
      strokes.push([stroke]);
    }

    const doc = InkDocument.fromBytes(Y.encodeStateAsUpdate(ydoc));
    expect(doc.visibleStrokes()).toEqual([]);
  });

  it('decodes legacy v1 payloads and ignores unknown payload versions', () => {
    const ydoc = new Y.Doc();
    const strokes = ydoc.getArray<Y.Map<unknown>>('strokes');

    const legacy = new Y.Map<unknown>();
    legacy.set('id', 'stroke_legacy');
    legacy.set('tombstoned', false);
    legacy.set(
      'payload',
      buildLegacyPayload(0xff112233, [{ x: 1, y: 2, pressure: 0.5 }])
    );
    strokes.push([legacy]);

    const unknown = new Y.Map<unknown>();
    unknown.set('id', 'stroke_unknown');
    unknown.set('tombstoned', false);
    unknown.set('payload', new Uint8Array([99, 1, 2, 3, 4]));
    strokes.push([unknown]);

    const doc = InkDocument.fromBytes(Y.encodeStateAsUpdate(ydoc));
    const [decoded] = doc.visibleStrokes();

    expect(doc.visibleStrokes()).toHaveLength(1);
    expect(decoded).toMatchObject({
      id: 'stroke_legacy',
      color: 0xff112233,
      width: DEFAULT_WIDTH,
      points: [{ x: 1, y: 2, pressure: 0.5 }]
    });
  });

  it('falls back to a non-UUID stroke id when crypto.randomUUID is unavailable', async () => {
    const originalCrypto = globalThis.crypto;
    const fallbackCrypto = {
      getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto)
    } as Crypto;

    vi.resetModules();
    vi.stubGlobal('crypto', fallbackCrypto);

    try {
      const { InkDocument: ReloadedInkDocument } = await import('./document');
      const doc = new ReloadedInkDocument();
      doc.beginStroke(DEFAULT_COLOR, DEFAULT_WIDTH);
      doc.pushPoint(0, 0, 1);
      const { value: id } = doc.endStroke();

      expect(id).toMatch(/^stroke_[0-9a-z]+_[0-9a-z]+$/);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

describe('ink page helpers', () => {
  it('computes point-to-segment distance with endpoint clamping', () => {
    expect(
      pointToSegmentDistanceSq({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })
    ).toBeCloseTo(9);
    expect(
      pointToSegmentDistanceSq({ x: 15, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })
    ).toBeCloseTo(25);
  });

  it('finds strokes hit by an eraser radius', () => {
    const strokes = [
      {
        id: 'a',
        color: DEFAULT_COLOR,
        width: DEFAULT_WIDTH,
        points: [
          { x: 0, y: 0, pressure: 1 },
          { x: 10, y: 0, pressure: 1 }
        ]
      },
      {
        id: 'b',
        color: DEFAULT_COLOR,
        width: DEFAULT_WIDTH,
        points: [
          { x: 100, y: 100, pressure: 1 },
          { x: 110, y: 100, pressure: 1 }
        ]
      }
    ];

    expect(strokesHitAt(strokes, { x: 5, y: 1 }, 3).map((s) => s.id)).toEqual([
      'a'
    ]);
  });

  it('keeps a trailing blank page after content', () => {
    expect(pageCountForContentMaxY(0)).toBe(2);
    expect(pageCountForContentMaxY(4000)).toBeGreaterThan(2);
  });
});

function buildPayload(
  color: number,
  width: number,
  points: number[],
  pressures: number[]
): Uint8Array {
  const out = new ArrayBuffer(13 + points.length * 4 + pressures.length * 4);
  const view = new DataView(out);
  let offset = 0;
  view.setUint8(offset, 2);
  offset += 1;
  view.setUint32(offset, color, true);
  offset += 4;
  view.setFloat32(offset, width, true);
  offset += 4;
  view.setUint32(offset, pressures.length, true);
  offset += 4;
  for (const p of points) {
    view.setFloat32(offset, p, true);
    offset += 4;
  }
  for (const p of pressures) {
    view.setFloat32(offset, p, true);
    offset += 4;
  }
  return new Uint8Array(out);
}

function buildLegacyPayload(
  color: number,
  points: Array<{ x: number; y: number; pressure: number }>
): Uint8Array {
  const out = new ArrayBuffer(9 + points.length * 12);
  const view = new DataView(out);
  let offset = 0;
  view.setUint8(offset, 1);
  offset += 1;
  view.setUint32(offset, color, true);
  offset += 4;
  view.setUint32(offset, points.length, true);
  offset += 4;
  for (const point of points) {
    view.setFloat32(offset, point.x, true);
    offset += 4;
    view.setFloat32(offset, point.y, true);
    offset += 4;
  }
  for (const point of points) {
    view.setFloat32(offset, point.pressure, true);
    offset += 4;
  }
  return new Uint8Array(out);
}
