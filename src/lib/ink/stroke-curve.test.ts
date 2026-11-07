import { describe, expect, it } from 'vitest';
import { traceStrokeCurve } from './stroke-curve';
import type { InkPoint } from './page';

function trace(points: InkPoint[]) {
  const pieces: Array<[string, ...number[]]> = [];
  traceStrokeCurve(points, {
    line: (x, y, pressure) => pieces.push(['line', x, y, pressure]),
    quad: (cx, cy, x, y, pressure) =>
      pieces.push(['quad', cx, cy, x, y, pressure])
  });
  return pieces;
}

const p = (x: number, y: number, pressure = 0.5): InkPoint => ({
  x,
  y,
  pressure
});

describe('traceStrokeCurve', () => {
  it('draws nothing for a single point and a straight line for two', () => {
    expect(trace([p(0, 0)])).toEqual([]);
    expect(trace([p(0, 0, 0.2), p(10, 0, 0.6)])).toEqual([
      ['line', 10, 0, 0.4]
    ]);
  });

  it('curves through each inner point between segment midpoints', () => {
    expect(trace([p(0, 0, 0.2), p(10, 0, 0.6), p(10, 10, 1)])).toEqual([
      ['line', 5, 0, 0.4],
      ['quad', 10, 0, 10, 5, 0.6],
      ['line', 10, 10, 0.8]
    ]);
  });

  it('ends exactly on the first and last points', () => {
    const pieces = trace([p(1, 2), p(5, 9), p(8, 3), p(12, 12)]);
    expect(pieces.at(-1)?.slice(1, 3)).toEqual([12, 12]);
    expect(pieces[0]).toEqual(['line', 3, 5.5, 0.5]);
  });
});
