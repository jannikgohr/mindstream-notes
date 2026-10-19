import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { InkDocument } from './document';
import {
  DEFAULT_PAGE,
  layoutForPages,
  pageRect,
  documentHeight,
  pageIndexAt
} from './page';
import {
  clipPoints,
  INK_PAGES,
  INK_PAGE_ORDER,
  INK_DELETED_PAGES
} from './page-document';
import { backgroundSignature } from './pdf-backgrounds';
import { parsePageRange, migratePdfInk } from './pdf-import';
import { sharedInkAnnotations } from './pdf-annotations';

const pages = [
  { id: 'a', width: 200, height: 300 },
  {
    id: 'b',
    width: 400,
    height: 200,
    background: { assetId: 'asset_pdf', pageIndex: 4 }
  }
];
const stroke = {
  color: 0xff000000,
  width: 4,
  points: [
    { x: 120, y: 20, pressure: 0.4 },
    { x: 140, y: 60, pressure: 0.8 }
  ]
};

describe('explicit ink pages', () => {
  it('lays out differently sized pages with centered widths and actual heights', () => {
    const layout = layoutForPages(pages);
    expect(pageRect(layout, 0)).toEqual([100, 0, 300, 300]);
    expect(pageRect(layout, 1)).toEqual([0, 372, 400, 572]);
    expect(documentHeight(layout)).toBe(572);
    expect(pageIndexAt(layout, 90, 20)).toBeNull();
    expect(pageIndexAt(layout, 20, 380)).toBe(1);
    expect(pageIndexAt(layout, 20, 350)).toBeNull();
  });
  it('persists page-local strokes and keeps them attached through reorder, delete and undo', () => {
    const ink = new InkDocument();
    ink.restorePages(pages);
    ink.addStrokes([stroke]);
    expect(ink.pageStrokes('a')[0].points[0]).toEqual({
      x: 20,
      y: 20,
      pressure: expect.closeTo(0.4)
    });
    ink.movePage('a', 1);
    expect(ink.pageStrokes('a')[0].points[0].x).toBe(20);
    expect(ink.visibleStrokes()[0].points[0].y).toBe(292);
    ink.deletePage('a');
    expect(ink.visibleStrokes()).toHaveLength(0);
    ink.undoLast();
    expect(ink.pageStrokes('a')).toHaveLength(1);
    const reopened = InkDocument.fromBytes(ink.encode());
    expect(reopened.pages().map((p) => p.id)).toEqual(['b', 'a']);
    expect(reopened.pageStrokes('a')[0].points).toEqual(
      ink.pageStrokes('a')[0].points
    );
  });
  it('migrates legacy geometry and retains its appearance when importing pages', () => {
    const ink = new InkDocument();
    ink.addStrokes([stroke]);
    ink.insertPages(
      [
        {
          id: 'pdf',
          width: 1684,
          height: 1190,
          background: { assetId: 'asset_x', pageIndex: 0 }
        }
      ],
      0
    );
    const local = ink.pageStrokes('legacy-page-0')[0];
    expect(local.points).toEqual(
      stroke.points.map((p) => ({
        ...p,
        pressure: expect.closeTo(p.pressure)
      }))
    );
    ink.undoLast();
    expect(ink.pages()).toHaveLength(2);
    expect(ink.visibleStrokes()[0].points[0].x).toBe(120);
  });
  it('converges concurrent moves and deletion without duplicate pages or resurrection', () => {
    const a = new InkDocument();
    a.restorePages([...pages, { id: 'c', ...DEFAULT_PAGE }]);
    const b = InkDocument.fromBytes(a.encode());
    a.movePage('b', 0);
    b.deletePage('b');
    const aa = a.encode(),
      bb = b.encode();
    a.applyRemoteUpdate(bb);
    b.applyRemoteUpdate(aa);
    expect(a.pages()).toEqual(b.pages());
    expect(a.pages().map((p) => p.id)).not.toContain('b');
  });
  it('restores page backgrounds and strokes from history, including background-only pages', () => {
    const ink = new InkDocument();
    ink.restorePages(pages);
    ink.addStrokes([stroke]);
    const snapshot = InkDocument.fromBytes(ink.encode());
    ink.deletePage('b');
    ink.clearAll();
    ink.restoreSnapshot(snapshot);
    expect(ink.pages()).toEqual(pages);
    expect(ink.pageStrokes('a')).toHaveLength(1);
  });
  it('two-device legacy migration produces one logical page set', () => {
    const a = new InkDocument();
    a.addStrokes([stroke]);
    const b = InkDocument.fromBytes(a.encode());
    a.insertPages([{ id: 'new-a', ...DEFAULT_PAGE }]);
    b.insertPages([{ id: 'new-b', ...DEFAULT_PAGE }]);
    const aa = a.encode(),
      bb = b.encode();
    a.applyRemoteUpdate(bb);
    b.applyRemoteUpdate(aa);
    expect(a.pages()).toEqual(b.pages());
    expect(new Set(a.pages().map((p) => p.id)).size).toBe(4);
  });
  it('keeps page metadata in independently mergeable roots', () => {
    const ink = new InkDocument();
    ink.restorePages(pages);
    expect(ink.doc.getMap(INK_PAGES).size).toBe(2);
    expect(ink.doc.getMap(INK_PAGE_ORDER).size).toBe(2);
    expect(ink.doc.getMap(INK_DELETED_PAGES).get('a')).toBe(false);
    expect(Y.encodeStateAsUpdate(ink.doc).length).toBeGreaterThan(0);
  });
});

it('clips legacy page crossings and interpolates pressure', () => {
  expect(
    clipPoints(
      [
        { x: 10, y: -10, pressure: 0.2 },
        { x: 10, y: 10, pressure: 0.8 }
      ],
      [0, 0, 100, 100]
    )[0][0]
  ).toEqual({ x: 10, y: 0, pressure: 0.5 });
});

it('rejects unknown future ink schemas instead of editing them as an empty note', () => {
  const doc = new Y.Doc();
  doc.getMap('ink:meta').set('schema', 99);
  expect(() => InkDocument.fromBytes(Y.encodeStateAsUpdate(doc))).toThrow(
    'newer app'
  );
});

it('splits legacy strokes crossing page boundaries without duplicating them on two-device migration', () => {
  const a = new InkDocument();
  a.addStrokes([
    {
      ...stroke,
      points: [
        { x: 100, y: 1670, pressure: 0.2 },
        { x: 100, y: 1780, pressure: 0.8 }
      ]
    }
  ]);
  const b = InkDocument.fromBytes(a.encode());
  a.insertPages([{ id: 'new-a', ...DEFAULT_PAGE }]);
  b.insertPages([{ id: 'new-b', ...DEFAULT_PAGE }]);
  const aa = a.encode(),
    bb = b.encode();
  a.applyRemoteUpdate(bb);
  b.applyRemoteUpdate(aa);
  expect(a.visibleStrokes()).toHaveLength(2);
  expect(a.visibleStrokes()).toEqual(b.visibleStrokes());
});

it('adapts horizontal shared strokes into nonzero PDF hit boxes with pressure intact', () => {
  const ink = new InkDocument();
  ink.restorePages([{ id: 'pdf-page-0', ...DEFAULT_PAGE }]);
  ink.addStrokes([
    {
      ...stroke,
      points: [
        { x: 10, y: 20, pressure: 0.25 },
        { x: 50, y: 20, pressure: 0.75 }
      ]
    }
  ]);
  const [annotation] = sharedInkAnnotations(ink.encode());
  expect(annotation.rects[0].width).toBeGreaterThan(0);
  expect(annotation.rects[0].height).toBeGreaterThan(0);
  expect(annotation.strokes![0].points[0]).toEqual({
    x: 5,
    y: 832,
    pressure: 0.25
  });
});

it('migrates legacy PDF strokes into editable shared ink once, preserving their fixed width', () => {
  const ink = new InkDocument();
  ink.restorePages([{ id: 'pdf-page-0', ...DEFAULT_PAGE }]);
  ink.doc.getMap('pdf_annotations').set('old', {
    id: 'old',
    type: 'ink',
    pageIndex: 0,
    opacity: 1,
    strokes: [
      {
        id: 's',
        color: '#112233',
        width: 2,
        points: [
          { x: 10, y: 20 },
          { x: 50, y: 40 }
        ]
      }
    ]
  });
  const peer = InkDocument.fromBytes(ink.encode());
  ink.transactLocalUpdate(() => migratePdfInk(ink));
  peer.transactLocalUpdate(() => migratePdfInk(peer));
  const before = ink.encode();
  ink.applyRemoteUpdate(peer.encode());
  peer.applyRemoteUpdate(before);
  expect(ink.visibleStrokes()).toHaveLength(1);
  expect(ink.visibleStrokes()).toEqual(peer.visibleStrokes());
  expect(ink.visibleStrokes()[0].width).toBe(4);
  expect(ink.visibleStrokes()[0].points[0]).toEqual({
    x: 20,
    y: 1644,
    pressure: 1
  });
  expect(ink.doc.getMap('pdf_annotations').size).toBe(0);
});
it('parses selected pages and rejects invalid ranges', () => {
  expect(parsePageRange('1, 3-5, 3', 5)).toEqual([0, 2, 3, 4]);
  for (const value of ['', '0', '6', '4-2', 'x'])
    expect(() => parsePageRange(value, 5)).toThrow();
});
it('signs only the ordered imported page instances and their text sources', () => {
  expect(backgroundSignature(pages)).toBe('[["b","asset_pdf",4]]');
  expect(backgroundSignature([...pages].reverse())).toBe(
    backgroundSignature(pages)
  );
  expect(backgroundSignature([pages[0]])).toBe('[]');
});
