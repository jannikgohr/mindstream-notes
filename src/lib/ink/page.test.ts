import { describe, expect, it } from 'vitest';
import {
  containsPagePoint,
  DEFAULT_PAGE,
  DEFAULT_PAGE_GAP,
  defaultLayout,
  documentHeight,
  forEachPageRect,
  layoutForPages,
  MIN_PAGE_COUNT,
  pageCountForContentMaxY,
  pageIndexAt,
  pageRect,
  pageTop,
  pointToSegmentDistanceSq,
  strideY
} from './page';

describe('page rectangle traversal', () => {
  const explicit = layoutForPages(
    Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      width: 200 + i / 3,
      height: 100 + i / 7
    }))
  );
  explicit.pageGap = 1 / 9;

  it.each([
    ['uniform', defaultLayout(12)],
    ['fractional pages', explicit],
    ['empty', layoutForPages([])],
    ['truncated', { ...explicit, pageCount: 3 }]
  ] as const)(
    'matches random access exactly for %s layouts',
    (_name, layout) => {
      const rects: unknown[] = [];
      forEachPageRect(layout, (rect) => rects.push(rect));
      expect(rects).toEqual(
        Array.from({ length: layout.pageCount }, (_, i) => pageRect(layout, i))
      );
    }
  );

  it('reads edited page geometry on the next traversal', () => {
    const layout = layoutForPages([
      { id: 'a', width: 200, height: 100 },
      { id: 'b', width: 200, height: 100 }
    ]);
    forEachPageRect(layout, () => {});
    layout.pages![0].height = 123.4;
    layout.pageGap = 10.1;
    const rects: unknown[] = [];
    forEachPageRect(layout, (rect) => rects.push(rect));
    expect(rects).toEqual([pageRect(layout, 0), pageRect(layout, 1)]);
  });

  it('retains the failure for an explicit page count longer than the page array', () => {
    const layout = {
      ...layoutForPages([{ id: 'a', width: 200, height: 100 }]),
      pageCount: 2
    };
    expect(() => pageRect(layout, 1)).toThrow(TypeError);
    expect(() => forEachPageRect(layout, () => {})).toThrow(TypeError);
  });
});

describe('defaultLayout', () => {
  it('uses the A4 page and enforces a minimum page count', () => {
    const layout = defaultLayout();
    expect(layout.page).toBe(DEFAULT_PAGE);
    expect(layout.pageGap).toBe(DEFAULT_PAGE_GAP);
    expect(layout.pageCount).toBe(MIN_PAGE_COUNT);
    expect(defaultLayout(1).pageCount).toBe(MIN_PAGE_COUNT);
    expect(defaultLayout(5).pageCount).toBe(5);
  });
});

describe('geometry', () => {
  const layout = defaultLayout(3);

  it('strideY is page height plus the gap', () => {
    expect(strideY(layout)).toBe(layout.page.height + layout.pageGap);
  });

  it('documentHeight accounts for inter-page gaps', () => {
    expect(documentHeight(layout)).toBe(
      layout.page.height * 3 + layout.pageGap * 2
    );
  });

  it('pageTop is index * stride', () => {
    expect(pageTop(layout, 0)).toBe(0);
    expect(pageTop(layout, 2)).toBe(2 * strideY(layout));
  });

  it('pageRect returns null out of range and a rect in range', () => {
    expect(pageRect(layout, -1)).toBeNull();
    expect(pageRect(layout, 3)).toBeNull();
    const rect = pageRect(layout, 1);
    expect(rect).not.toBeNull();
    expect(rect![0]).toBe(0);
    expect(rect![2]).toBe(layout.page.width);
  });
});

describe('pageIndexAt / containsPagePoint', () => {
  const layout = defaultLayout(2);

  it('locates a point on the first page', () => {
    expect(pageIndexAt(layout, 10, 10)).toBe(0);
    expect(containsPagePoint(layout, 10, 10)).toBe(true);
  });

  it('locates a point on the second page', () => {
    const y = strideY(layout) + 5;
    expect(pageIndexAt(layout, 10, y)).toBe(1);
  });

  it('returns null off the left/right/top/bottom edges', () => {
    expect(pageIndexAt(layout, -1, 10)).toBeNull();
    expect(pageIndexAt(layout, layout.page.width + 1, 10)).toBeNull();
    expect(pageIndexAt(layout, 10, -1)).toBeNull();
    expect(pageIndexAt(layout, 10, documentHeight(layout) + 1)).toBeNull();
  });

  it('returns null when the point lands in the inter-page gap', () => {
    const inGap = layout.page.height + layout.pageGap / 2;
    expect(pageIndexAt(layout, 10, inGap)).toBeNull();
    expect(containsPagePoint(layout, 10, inGap)).toBe(false);
  });
});

describe('pageCountForContentMaxY', () => {
  it('returns the minimum for empty/invalid content', () => {
    expect(pageCountForContentMaxY(0)).toBe(MIN_PAGE_COUNT);
    expect(pageCountForContentMaxY(-10)).toBe(MIN_PAGE_COUNT);
    expect(pageCountForContentMaxY(NaN)).toBe(MIN_PAGE_COUNT);
  });

  it('grows with content height (with a trailing spare page)', () => {
    const layout = defaultLayout();
    const twoPagesDown = strideY(layout) * 2;
    expect(pageCountForContentMaxY(twoPagesDown)).toBeGreaterThan(
      MIN_PAGE_COUNT
    );
  });
});

describe('pointToSegmentDistanceSq', () => {
  it('is zero for a point on the segment', () => {
    expect(
      pointToSegmentDistanceSq({ x: 5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })
    ).toBeCloseTo(0);
  });

  it('measures perpendicular distance squared', () => {
    expect(
      pointToSegmentDistanceSq({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })
    ).toBeCloseTo(9);
  });

  it('clamps to the nearest endpoint past the segment ends', () => {
    expect(
      pointToSegmentDistanceSq({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })
    ).toBeCloseTo(25);
  });

  it('handles a degenerate zero-length segment', () => {
    expect(
      pointToSegmentDistanceSq({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })
    ).toBeCloseTo(25);
  });
});
