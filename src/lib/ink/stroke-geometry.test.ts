import { describe, expect, it } from 'vitest';
import {
  boundsContainPoint,
  boundsIntersect,
  boundsOfPoints,
  pointInPolygon,
  segmentsIntersect,
  strokeIntersectsLasso,
  tileCoord,
  tileKey
} from './stroke-geometry';
import type { StrokeMeta } from './stroke-types';

function stroke(points: Array<[number, number]>): StrokeMeta {
  const pts = points.map(([x, y]) => ({ x, y, pressure: 0.5 }));
  return {
    id: 's',
    color: 0,
    width: 1,
    points: pts,
    bounds: boundsOfPoints(pts)
  };
}

const square = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 }
];

describe('boundsOfPoints', () => {
  it('returns a zero box for an empty stroke rather than infinities', () => {
    expect(boundsOfPoints([])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });

  it('spans every point', () => {
    const bounds = boundsOfPoints([
      { x: 3, y: -1, pressure: 0.5 },
      { x: -2, y: 7, pressure: 0.5 }
    ]);
    expect(bounds).toEqual({ minX: -2, minY: -1, maxX: 3, maxY: 7 });
  });
});

describe('boundsContainPoint', () => {
  const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

  it('grows the box by the radius so a near miss still counts', () => {
    expect(boundsContainPoint(bounds, { x: 12, y: 5 }, 0)).toBe(false);
    expect(boundsContainPoint(bounds, { x: 12, y: 5 }, 3)).toBe(true);
  });
});

describe('boundsIntersect', () => {
  const a = { minX: 0, minY: 0, maxX: 5, maxY: 5 };

  it('treats edge-touching boxes as intersecting', () => {
    expect(boundsIntersect(a, { minX: 5, minY: 5, maxX: 9, maxY: 9 }, 0)).toBe(
      true
    );
  });

  it('separates disjoint boxes', () => {
    expect(boundsIntersect(a, { minX: 6, minY: 6, maxX: 9, maxY: 9 }, 0)).toBe(
      false
    );
  });

  it('closes a gap narrower than the padding', () => {
    const b = { minX: 8, minY: 0, maxX: 9, maxY: 5 };
    expect(boundsIntersect(a, b, 0)).toBe(false);
    expect(boundsIntersect(a, b, 4)).toBe(true);
  });
});

describe('pointInPolygon', () => {
  it('accepts an interior point and rejects an exterior one', () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
  });

  it('handles a concave polygon, where a bounding box would not', () => {
    // A "U": the gap between the arms is outside the shape but inside its box.
    const u = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 7, y: 10 },
      { x: 7, y: 3 },
      { x: 3, y: 3 },
      { x: 3, y: 10 },
      { x: 0, y: 10 }
    ];
    expect(pointInPolygon({ x: 5, y: 1 }, u)).toBe(true);
    expect(pointInPolygon({ x: 5, y: 8 }, u)).toBe(false);
  });
});

describe('segmentsIntersect', () => {
  it('detects a crossing', () => {
    expect(
      segmentsIntersect(
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
        { x: 10, y: 0 }
      )
    ).toBe(true);
  });

  it('rejects parallel segments', () => {
    expect(
      segmentsIntersect(
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 0, y: 5 },
        { x: 10, y: 5 }
      )
    ).toBe(false);
  });

  it('counts a touching endpoint as an intersection', () => {
    expect(
      segmentsIntersect(
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 5 }
      )
    ).toBe(true);
  });
});

describe('strokeIntersectsLasso', () => {
  it('selects a stroke drawn entirely inside the lasso', () => {
    expect(
      strokeIntersectsLasso(
        stroke([
          [2, 2],
          [4, 4]
        ]),
        square
      )
    ).toBe(true);
  });

  it('selects a stroke that only crosses the lasso edge', () => {
    // Neither endpoint is inside, so this only passes via the
    // segment-intersection sweep.
    expect(
      strokeIntersectsLasso(
        stroke([
          [-5, 5],
          [15, 5]
        ]),
        square
      )
    ).toBe(true);
  });

  it('ignores a stroke outside the lasso', () => {
    expect(
      strokeIntersectsLasso(
        stroke([
          [20, 20],
          [30, 30]
        ]),
        square
      )
    ).toBe(false);
  });

  it('ignores a degenerate lasso with fewer than three points', () => {
    expect(
      strokeIntersectsLasso(
        stroke([
          [2, 2],
          [4, 4]
        ]),
        square.slice(0, 2)
      )
    ).toBe(false);
  });
});

describe('tile keys', () => {
  it('floors toward negative infinity so tiles tile the whole plane', () => {
    expect(tileCoord(0, 512)).toBe(0);
    expect(tileCoord(511, 512)).toBe(0);
    expect(tileCoord(512, 512)).toBe(1);
    expect(tileCoord(-1, 512)).toBe(-1);
  });

  it('formats a stable key per tile', () => {
    expect(tileKey(1, -2)).toBe('1:-2');
  });
});
