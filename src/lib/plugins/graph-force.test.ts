import { describe, expect, it } from 'vitest';
import { createForceLayout, type ForceOptions } from './graph-force';

function layoutOf(
  nodes: number,
  links: number[],
  overrides: Partial<ForceOptions> = {}
) {
  return createForceLayout({
    radius: new Float32Array(nodes).fill(4),
    x: new Float32Array(nodes).fill(NaN),
    y: new Float32Array(nodes).fill(NaN),
    links: Uint32Array.from(links),
    alpha: 1,
    alphaDecay: 1 - 0.001 ** (1 / 300),
    chargeReach: Infinity,
    theta: 0.9,
    collide: true,
    ...overrides
  });
}

function settle(layout: ReturnType<typeof createForceLayout>) {
  while (!layout.settled()) layout.tick();
}

const distance = (
  layout: ReturnType<typeof createForceLayout>,
  a: number,
  b: number
) => Math.hypot(layout.x[a] - layout.x[b], layout.y[a] - layout.y[b]);

describe('createForceLayout', () => {
  it('rests two linked nodes a little past the link length', () => {
    const layout = layoutOf(2, [0, 1]);
    settle(layout);
    expect(distance(layout, 0, 1)).toBeGreaterThan(40);
    expect(distance(layout, 0, 1)).toBeLessThan(70);
  });

  it('keeps linked nodes nearer than unlinked ones', () => {
    // Two triangles joined by nothing.
    const layout = layoutOf(6, [0, 1, 1, 2, 2, 0, 3, 4, 4, 5, 5, 3]);
    settle(layout);
    expect(distance(layout, 0, 1)).toBeLessThan(distance(layout, 0, 3));
    expect(distance(layout, 3, 4)).toBeLessThan(distance(layout, 1, 4));
  });

  it('parts nodes that start in one place', () => {
    const layout = layoutOf(5, [], {
      x: new Float32Array(5),
      y: new Float32Array(5)
    });
    settle(layout);
    for (let a = 0; a < 5; a++) {
      expect(Number.isFinite(layout.x[a])).toBe(true);
      for (let b = a + 1; b < 5; b++)
        expect(distance(layout, a, b)).toBeGreaterThan(8);
    }
  });

  it('groups far nodes without changing where the layout pushes', () => {
    // One tick from the same start, exact against grouped: the moves agree.
    const n = 400;
    const start = () => {
      const x = new Float32Array(n);
      const y = new Float32Array(n);
      let seed = 3;
      const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < n; i++) {
        x[i] = (random() - 0.5) * 2000;
        y[i] = (random() - 0.5) * 2000;
      }
      return { x, y, collide: false };
    };
    const exact = layoutOf(n, [], { ...start(), theta: 0 });
    const grouped = layoutOf(n, [], { ...start(), theta: 0.9 });
    const from = start();
    exact.tick();
    grouped.tick();
    let error = 0;
    let moved = 0;
    for (let i = 0; i < n; i++) {
      error += Math.hypot(exact.x[i] - grouped.x[i], exact.y[i] - grouped.y[i]);
      moved += Math.hypot(exact.x[i] - from.x[i], exact.y[i] - from.y[i]);
    }
    expect(moved).toBeGreaterThan(0);
    expect(error / moved).toBeLessThan(0.05);
  });

  it('holds a pinned node and brings its neighbour along', () => {
    const layout = layoutOf(2, [0, 1]);
    settle(layout);
    layout.pin(0, { x: 500, y: 500 });
    layout.alphaTarget = 0.3;
    for (let i = 0; i < 300; i++) layout.tick();
    expect(layout.x[0]).toBe(500);
    expect(layout.y[0]).toBe(500);
    expect(distance(layout, 0, 1)).toBeLessThan(150);

    layout.pin(0, undefined);
    layout.alphaTarget = 0;
    settle(layout);
    expect(Math.hypot(layout.x[0], layout.y[0])).toBeLessThan(400);
  });
});
