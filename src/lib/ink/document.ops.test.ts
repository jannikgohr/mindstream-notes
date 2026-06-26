import { describe, expect, it } from 'vitest';
import { InkDocument } from './document';

/** Build a doc with one stroke from a→b and return [doc, id]. */
function docWithStroke(
  ax = 0,
  ay = 0,
  bx = 100,
  by = 0
): [InkDocument, string] {
  const doc = new InkDocument();
  doc.beginStroke(0xff112233, 4);
  doc.pushPoint(ax, ay);
  doc.pushPoint(bx, by);
  const { value: id } = doc.endStroke();
  return [doc, id!];
}

describe('addStrokes / deleteStrokes', () => {
  it('adds several strokes at once', () => {
    const doc = new InkDocument();
    const { value: ids } = doc.addStrokes([
      { color: 0xff000000, width: 2, points: [{ x: 0, y: 0, pressure: 1 }] },
      { color: 0xffffffff, width: 3, points: [{ x: 5, y: 5, pressure: 1 }] }
    ]);
    expect(ids).toHaveLength(2);
    expect(doc.visibleStrokeCount()).toBe(2);
  });

  it('deletes (tombstones) strokes by id', () => {
    const [doc, id] = docWithStroke();
    const { value: deleted } = doc.deleteStrokes([id]);
    expect(deleted).toEqual([id]);
    expect(doc.visibleStrokeCount()).toBe(0);
  });
});

describe('eraseAt', () => {
  it('erases a stroke the eraser passes over', () => {
    const [doc] = docWithStroke(0, 0, 100, 0);
    const { value: erased } = doc.eraseAt({ x: 50, y: 0 }, 5);
    expect(erased).toHaveLength(1);
    expect(doc.visibleStrokeCount()).toBe(0);
  });

  it('leaves strokes far from the eraser untouched', () => {
    const [doc] = docWithStroke(0, 0, 100, 0);
    const { value: erased } = doc.eraseAt({ x: 50, y: 500 }, 5);
    expect(erased).toHaveLength(0);
    expect(doc.visibleStrokeCount()).toBe(1);
  });
});

describe('translate / transform / style', () => {
  it('translates a stroke', () => {
    const [doc, id] = docWithStroke(0, 0, 10, 0);
    doc.translateStrokes([id], 5, 7);
    const [stroke] = doc.visibleStrokes();
    expect(stroke.points[0]).toMatchObject({ x: 5, y: 7 });
  });

  it('ignores a no-op translate', () => {
    const [doc, id] = docWithStroke();
    const { value } = doc.translateStrokes([id], 0, 0);
    expect(value).toEqual([]);
  });

  it('applies a scaling transform with width scale', () => {
    const [doc, id] = docWithStroke(0, 0, 10, 0);
    doc.transformStrokes([id], {
      a: 2,
      b: 0,
      c: 0,
      d: 2,
      e: 0,
      f: 0,
      widthScale: 2
    });
    const [stroke] = doc.visibleStrokes();
    expect(stroke.points[1].x).toBeCloseTo(20);
    expect(stroke.width).toBeCloseTo(8);
  });

  it('rejects an identity transform as a no-op', () => {
    const [doc, id] = docWithStroke();
    const { value } = doc.transformStrokes([id], {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: 0,
      f: 0,
      widthScale: 1
    });
    expect(value).toEqual([]);
  });

  it('restyles colour and width', () => {
    const [doc, id] = docWithStroke();
    doc.styleStrokes([id], { color: 0xffabcdef, width: 9 });
    const [stroke] = doc.visibleStrokes();
    expect(stroke.color).toBe(0xffabcdef);
    expect(stroke.width).toBeCloseTo(9);
  });
});

describe('lasso + bounds queries', () => {
  it('selects strokes inside a lasso polygon', () => {
    const [doc, id] = docWithStroke(10, 10, 20, 20);
    const ids = doc.strokeIdsInLasso([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 }
    ]);
    expect(ids).toContain(id);
  });

  it('returns nothing for a degenerate lasso', () => {
    const [doc] = docWithStroke();
    expect(doc.strokeIdsInLasso([{ x: 0, y: 0 }])).toEqual([]);
  });

  it('finds strokes intersecting a bounds query', () => {
    const [doc, id] = docWithStroke(0, 0, 10, 0);
    const hits = doc.visibleStrokesInBounds({
      minX: -5,
      minY: -5,
      maxX: 15,
      maxY: 5
    });
    expect(hits.map((s) => s.id)).toContain(id);
  });
});

describe('clearAll + undo/redo', () => {
  it('clears every visible stroke and undo restores them', () => {
    const [doc] = docWithStroke();
    doc.clearAll();
    expect(doc.visibleStrokeCount()).toBe(0);
    doc.undoLast();
    expect(doc.visibleStrokeCount()).toBe(1);
    doc.redoLast();
    expect(doc.visibleStrokeCount()).toBe(0);
  });

  it('undoes and redoes a single stroke addition', () => {
    const [doc] = docWithStroke();
    expect(doc.visibleStrokeCount()).toBe(1);
    const { value: undone } = doc.undoLast();
    expect(undone).toBe(true);
    expect(doc.visibleStrokeCount()).toBe(0);
    const { value: redone } = doc.redoLast();
    expect(redone).toBe(true);
    expect(doc.visibleStrokeCount()).toBe(1);
  });

  it('reports false when there is nothing to undo/redo', () => {
    const doc = new InkDocument();
    expect(doc.undoLast().value).toBe(false);
    expect(doc.redoLast().value).toBe(false);
  });
});

describe('state vector encoding', () => {
  it('produces a diff update against a peer state vector', () => {
    const [doc] = docWithStroke();
    const empty = new InkDocument();
    const sv = empty.encodeStateVector();
    const diff = doc.encodeDiffForStateVector(sv);
    expect(diff.byteLength).toBeGreaterThan(0);

    // Applying the diff to the empty peer converges it.
    expect(empty.applyRemoteUpdate(diff)).toBe(true);
    expect(empty.visibleStrokeCount()).toBe(1);
  });
});
