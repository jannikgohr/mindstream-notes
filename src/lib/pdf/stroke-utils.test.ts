import { describe, expect, it } from 'vitest';
import {
  cloneInkStroke,
  cloneSignatureSnapshot,
  strokeBounds,
  strokePointsAttr,
  translateRect,
  translateStroke
} from './stroke-utils';
import type { PdfInkStroke } from './types';

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
