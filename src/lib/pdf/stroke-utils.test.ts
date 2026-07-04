import { describe, expect, it } from 'vitest';
import {
  cloneInkStroke,
  cloneSignatureSnapshot,
  strokeBounds,
  strokeOutlinePath,
  strokePointsAttr,
  translateRect,
  translateStroke
} from './stroke-utils';
import type { PdfInkStroke, PdfStrokePoint } from './types';

const stroke = (): PdfInkStroke => ({
  id: 's1',
  color: '#111',
  width: 2,
  points: [
    { x: 1, y: 2 },
    { x: 3, y: 4, pressure: 0.5 }
  ]
});

describe('strokePointsAttr', () => {
  it('joins points into an SVG polyline attribute', () => {
    expect(strokePointsAttr(stroke().points)).toBe('1,2 3,4');
  });

  it('returns an empty string for no points', () => {
    expect(strokePointsAttr([])).toBe('');
  });
});

describe('strokeOutlinePath', () => {
  const line = (pressures: Array<number | undefined>): PdfStrokePoint[] =>
    pressures.map((pressure, i) => ({ x: i * 20, y: 0, pressure }));

  it('produces a closed filled path', () => {
    const d = strokeOutlinePath({ width: 4, points: line([1, 1, 1, 1]) });
    expect(d.startsWith('M ')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
  });

  it('normalises uniform pressure to the nominal width', () => {
    // A constant mouse pressure of 0.5 must render exactly like
    // pressure 1 — old saved signatures keep their appearance.
    const full = strokeOutlinePath({ width: 4, points: line([1, 1, 1, 1]) });
    const mouse = strokeOutlinePath({
      width: 4,
      points: line([0.5, 0.5, 0.5, 0.5])
    });
    const missing = strokeOutlinePath({
      width: 4,
      points: line([undefined, undefined, undefined, undefined])
    });
    expect(mouse).toBe(full);
    expect(missing).toBe(full);
  });

  it('renders varying pressure differently from uniform pressure', () => {
    const uniform = strokeOutlinePath({ width: 4, points: line([1, 1, 1, 1]) });
    const tapered = strokeOutlinePath({
      width: 4,
      points: line([1.6, 1.2, 0.8, 0.4])
    });
    expect(tapered).not.toBe(uniform);
  });

  it('widens the outline where pressure is higher', () => {
    // Horizontal stroke: outline y-extent near the thick end must beat
    // the thin end. Parse coordinates back out of the path string.
    const d = strokeOutlinePath({
      width: 10,
      points: line([1.5, 1.5, 0.5, 0.5])
    });
    const coords = d
      .match(/-?\d+(\.\d+)?/g)!
      .map(Number)
      .reduce<Array<[number, number]>>((acc, n, i, arr) => {
        if (i % 2 === 0 && i + 1 < arr.length) acc.push([n, arr[i + 1]]);
        return acc;
      }, []);
    const spread = (filter: (x: number) => boolean) => {
      const ys = coords.filter(([x]) => filter(x)).map(([, y]) => y);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(spread((x) => x < 15)).toBeGreaterThan(spread((x) => x > 45));
  });

  it('returns an empty string for empty input', () => {
    expect(strokeOutlinePath({ width: 4, points: [] })).toBe('');
  });
});

describe('strokeBounds', () => {
  it('computes the axis-aligned bounding box', () => {
    expect(
      strokeBounds([
        { x: 1, y: 2 },
        { x: 5, y: 8 },
        { x: 3, y: -1 }
      ])
    ).toEqual({ x: 1, y: -1, width: 4, height: 9 });
  });

  it('applies symmetric padding', () => {
    expect(strokeBounds([{ x: 10, y: 10 }], 2)).toEqual({
      x: 8,
      y: 8,
      width: 4,
      height: 4
    });
  });

  it('returns a zero rect at the origin for empty input', () => {
    expect(strokeBounds([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('translateStroke', () => {
  it('shifts every point and keeps pressure, without mutating the input', () => {
    const original = stroke();
    const moved = translateStroke(original, 10, -5);
    expect(moved.points).toEqual([
      { x: 11, y: -3 },
      { x: 13, y: -1, pressure: 0.5 }
    ]);
    expect(original.points[0]).toEqual({ x: 1, y: 2 });
    expect(moved.id).toBe(original.id);
  });
});

describe('translateRect', () => {
  it('shifts the origin and leaves the size untouched', () => {
    expect(translateRect({ x: 1, y: 2, width: 3, height: 4 }, 5, -1)).toEqual({
      x: 6,
      y: 1,
      width: 3,
      height: 4
    });
  });
});

describe('cloneInkStroke', () => {
  it('deep-copies points so the clone shares no references', () => {
    const original = stroke();
    const clone = cloneInkStroke(original);
    expect(clone).toEqual(original);
    expect(clone).not.toBe(original);
    expect(clone.points[0]).not.toBe(original.points[0]);
  });
});

describe('cloneSignatureSnapshot', () => {
  it('deep-copies the snapshot and every stroke', () => {
    const original = {
      id: 'sig',
      width: 100,
      height: 50,
      strokes: [stroke()]
    };
    const clone = cloneSignatureSnapshot(original);
    expect(clone).toEqual(original);
    expect(clone.strokes[0]).not.toBe(original.strokes[0]);
    expect(clone.strokes[0].points[0]).not.toBe(original.strokes[0].points[0]);
  });
});
