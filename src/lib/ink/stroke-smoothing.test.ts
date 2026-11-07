import { describe, expect, it } from 'vitest';
import {
  NO_SMOOTHING,
  smoothStroke,
  strokeSmoothing,
  type StrokeSmoothing
} from './stroke-smoothing';
import type { InkPoint } from './page';

/** What a mouse reports along a path: whole pixels, one per change. */
function mouseSamples(path: (t: number) => [number, number]): InkPoint[] {
  const out: InkPoint[] = [];
  for (let i = 0; i <= 4000; i += 1) {
    const [x, y] = path(i / 4000);
    const point = { x: Math.round(x), y: Math.round(y), pressure: 0.5 };
    const last = out.at(-1);
    if (!last || last.x !== point.x || last.y !== point.y) out.push(point);
  }
  return out;
}

function rms(values: number[]): number {
  return Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length);
}

/** Device-pixel smoothing for a mouse at 1:1 zoom. */
const mouse = strokeSmoothing('mouse', 1, 1);

describe('strokeSmoothing', () => {
  it('sizes the filter in device pixels at the zoom the stroke is drawn at', () => {
    // Zoomed out to a quarter on a 2× screen, one device pixel is two
    // page units, so the filter covers twice as many page units.
    const zoomedOut = strokeSmoothing('mouse', 0.25, 2);
    expect(zoomedOut.radius).toBeCloseTo(mouse.radius * 2);
    expect(zoomedOut.maxShift).toBeCloseTo(mouse.maxShift * 2);
  });

  it('smooths a mouse harder than a pen and treats unknown input as a pen', () => {
    const pen = strokeSmoothing('pen', 1, 1);
    expect(mouse.radius).toBeGreaterThan(pen.radius);
    expect(strokeSmoothing('', 1, 1)).toEqual(pen);
  });

  it('turns itself off for an unusable zoom', () => {
    expect(strokeSmoothing('mouse', 0, 1)).toEqual(NO_SMOOTHING);
  });
});

describe('smoothStroke', () => {
  it('returns short strokes and disabled smoothing untouched', () => {
    const two = [
      { x: 0, y: 0, pressure: 1 },
      { x: 1, y: 1, pressure: 1 }
    ];
    expect(smoothStroke(two, mouse)).toBe(two);
    const line = mouseSamples((t) => [t * 50, t * 9]);
    expect(smoothStroke(line, NO_SMOOTHING)).toBe(line);
  });

  it('pins both ends and keeps every pressure, so the pen tip never lags', () => {
    const raw = mouseSamples((t) => [t * 80, 20 * Math.sin(t * 6)]).map(
      (p, i) => ({ ...p, pressure: 0.2 + (i % 7) / 10 })
    );
    const smoothed = smoothStroke(raw, mouse);
    expect(smoothed[0]).toEqual(raw[0]);
    expect(smoothed.at(-1)).toEqual(raw.at(-1));
    expect(smoothed.map((p) => p.pressure)).toEqual(raw.map((p) => p.pressure));
  });

  it('never moves a point further than maxShift', () => {
    let seed = 7;
    const random = () =>
      (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
    const raw = Array.from({ length: 400 }, (_, i) => ({
      x: i * 0.7 + random() * 6,
      y: Math.sin(i / 9) * 30 + random() * 6,
      pressure: 1
    }));
    const smoothing: StrokeSmoothing = { radius: 10, maxShift: 0.4 };
    const smoothed = smoothStroke(raw, smoothing);
    for (let i = 0; i < raw.length; i += 1) {
      const shift = Math.hypot(
        smoothed[i].x - raw[i].x,
        smoothed[i].y - raw[i].y
      );
      expect(shift).toBeLessThanOrEqual(0.4 + 1e-9);
    }
  });

  it('straightens the stairs of a pixel-snapped mouse line', () => {
    const raw = mouseSamples((t) => [t * 120, t * 20]);
    const offLine = (p: InkPoint) =>
      Math.abs(p.y - p.x / 6) * Math.cos(Math.atan(1 / 6));
    const before = rms(raw.map(offLine));
    const after = rms(smoothStroke(raw, mouse).map(offLine));
    expect(before).toBeGreaterThan(0.3);
    expect(after).toBeLessThan(0.1);
  });

  it('keeps the size of a small loop instead of shrinking it', () => {
    // A 6 px "o" written zoomed out: an average would pull it inward.
    const raw = mouseSamples((t) => [
      10 + 6 * Math.cos(t * 2 * Math.PI),
      10 + 6 * Math.sin(t * 2 * Math.PI)
    ]);
    const radii = smoothStroke(raw, mouse).map((p) =>
      Math.hypot(p.x - 10, p.y - 10)
    );
    const meanRadius = radii.reduce((sum, r) => sum + r, 0) / radii.length;
    expect(meanRadius).toBeGreaterThan(5.85);
    expect(rms(radii.map((r) => r - 6))).toBeLessThan(0.15);
  });

  it('gives the same shape at any zoom once sized for it', () => {
    const raw = mouseSamples((t) => [t * 60, 15 * Math.sin(t * 4)]);
    const scaled = raw.map((p) => ({ ...p, x: p.x * 3, y: p.y * 3 }));
    const atOne = smoothStroke(raw, mouse);
    const atThird = smoothStroke(scaled, strokeSmoothing('mouse', 1 / 3, 1));
    atThird.forEach((p, i) => {
      expect(p.x).toBeCloseTo(atOne[i].x * 3, 6);
      expect(p.y).toBeCloseTo(atOne[i].y * 3, 6);
    });
  });
});
