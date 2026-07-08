import { describe, expect, it } from 'vitest';
import {
  centeredPatternPositions,
  normalizeInkPageBackgroundOpacity
} from './editor-helpers';

describe('normalizeInkPageBackgroundOpacity', () => {
  it('maps percentages to a clamped 0-1 multiplier', () => {
    expect(normalizeInkPageBackgroundOpacity(50)).toBe(0.5);
    expect(normalizeInkPageBackgroundOpacity('25')).toBe(0.25);
    expect(normalizeInkPageBackgroundOpacity(-10)).toBe(0);
    expect(normalizeInkPageBackgroundOpacity(150)).toBe(1);
    expect(normalizeInkPageBackgroundOpacity('garbage')).toBe(1);
  });
});

describe('centeredPatternPositions', () => {
  it('centers a repeating pattern inside the available span', () => {
    const positions = centeredPatternPositions(0, 100, 28);

    expect(positions).toEqual([22, 50, 78]);
  });

  it('returns no marks when the step cannot fit', () => {
    expect(centeredPatternPositions(0, 20, 28)).toEqual([]);
  });
});
