import { describe, expect, it } from 'vitest';
import {
  EDGE_SCROLL_MAX_SPEED_PX_PER_MS,
  EDGE_SCROLL_ZONE_PX,
  edgeScrollSpeed
} from './edge-auto-scroll';

describe('edgeScrollSpeed', () => {
  const start = 100;
  const end = 600;

  it('does not scroll away from the edges', () => {
    expect(edgeScrollSpeed(350, start, end)).toBe(0);
    expect(edgeScrollSpeed(start + EDGE_SCROLL_ZONE_PX, start, end)).toBe(0);
  });

  it('speeds up the closer the pointer gets to an edge', () => {
    const near = edgeScrollSpeed(end - 10, start, end);
    const nearer = edgeScrollSpeed(end - 2, start, end);
    expect(near).toBeGreaterThan(0);
    expect(nearer).toBeGreaterThan(near);
    expect(edgeScrollSpeed(end, start, end)).toBe(
      EDGE_SCROLL_MAX_SPEED_PX_PER_MS
    );
  });

  it('scrolls toward the start near the start edge', () => {
    expect(edgeScrollSpeed(start + 10, start, end)).toBeLessThan(0);
    expect(edgeScrollSpeed(start, start, end)).toBe(
      -EDGE_SCROLL_MAX_SPEED_PX_PER_MS
    );
  });

  it('holds full speed once the pointer leaves the container', () => {
    expect(edgeScrollSpeed(end + 200, start, end)).toBe(
      EDGE_SCROLL_MAX_SPEED_PX_PER_MS
    );
    expect(edgeScrollSpeed(start - 200, start, end)).toBe(
      -EDGE_SCROLL_MAX_SPEED_PX_PER_MS
    );
  });

  it('keeps the middle third of a small container still', () => {
    expect(edgeScrollSpeed(50, 0, 90)).toBe(0);
    expect(edgeScrollSpeed(25, 0, 90)).toBeLessThan(0);
    expect(edgeScrollSpeed(65, 0, 90)).toBeGreaterThan(0);
  });

  it('never scrolls an empty container', () => {
    expect(edgeScrollSpeed(0, 0, 0)).toBe(0);
  });
});
