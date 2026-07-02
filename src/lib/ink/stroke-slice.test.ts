import { describe, expect, it } from 'vitest';
import { sliceStrokeByCircles, type EraserCircle } from './stroke-slice';
import type { InkPoint } from './page';

const p = (x: number, y: number, pressure = 1): InkPoint => ({
  x,
  y,
  pressure
});

/** A straight horizontal line from (0,0) to (100,0). */
const line = (): InkPoint[] => [p(0, 0), p(100, 0)];

describe('sliceStrokeByCircles', () => {
  it('leaves a stroke untouched when no circle overlaps it', () => {
    const circles: EraserCircle[] = [{ x: 50, y: 50, r: 5 }];
    const result = sliceStrokeByCircles(line(), circles);
    expect(result.changed).toBe(false);
    expect(result.fragments).toEqual([line()]);
  });

  it('splits a line into two fragments when erased in the middle', () => {
    const circles: EraserCircle[] = [{ x: 50, y: 0, r: 10 }];
    const result = sliceStrokeByCircles(line(), circles);
    expect(result.changed).toBe(true);
    expect(result.fragments).toHaveLength(2);
    // Left piece runs from x=0 to x=40, right from x=60 to x=100.
    expect(result.fragments[0][0]).toMatchObject({ x: 0, y: 0 });
    expect(result.fragments[0][1].x).toBeCloseTo(40);
    expect(result.fragments[1][0].x).toBeCloseTo(60);
    expect(result.fragments[1][1]).toMatchObject({ x: 100, y: 0 });
  });

  it('trims one end when the eraser covers a start', () => {
    const circles: EraserCircle[] = [{ x: 0, y: 0, r: 20 }];
    const result = sliceStrokeByCircles(line(), circles);
    expect(result.changed).toBe(true);
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0][0].x).toBeCloseTo(20);
    expect(result.fragments[0][1]).toMatchObject({ x: 100, y: 0 });
  });

  it('removes the whole stroke when fully covered', () => {
    const circles: EraserCircle[] = [{ x: 50, y: 0, r: 200 }];
    const result = sliceStrokeByCircles(line(), circles);
    expect(result.changed).toBe(true);
    expect(result.fragments).toHaveLength(0);
  });

  it('keeps a multi-segment stroke connected across surviving vertices', () => {
    const stroke = [p(0, 0), p(50, 0), p(100, 0), p(150, 0)];
    // Erase only around the last vertex region (x≈125..150).
    const circles: EraserCircle[] = [{ x: 140, y: 0, r: 15 }];
    const result = sliceStrokeByCircles(stroke, circles);
    expect(result.changed).toBe(true);
    expect(result.fragments).toHaveLength(1);
    const frag = result.fragments[0];
    // The first three vertices stay joined into a single fragment.
    expect(frag[0]).toMatchObject({ x: 0 });
    expect(frag[frag.length - 1].x).toBeCloseTo(125);
  });

  it('interpolates pressure at cut points', () => {
    const stroke = [p(0, 0, 0), p(100, 0, 1)];
    const circles: EraserCircle[] = [{ x: 50, y: 0, r: 10 }];
    const result = sliceStrokeByCircles(stroke, circles);
    // Left piece ends at x=40 → pressure ≈ 0.4.
    const leftEnd = result.fragments[0][1];
    expect(leftEnd.pressure).toBeCloseTo(0.4);
  });

  it('produces three fragments for two separated erase circles', () => {
    const circles: EraserCircle[] = [
      { x: 30, y: 0, r: 5 },
      { x: 70, y: 0, r: 5 }
    ];
    const result = sliceStrokeByCircles(line(), circles);
    expect(result.changed).toBe(true);
    expect(result.fragments).toHaveLength(3);
  });
});
