import { describe, expect, it } from 'vitest';
import {
  CARD_DRAG_EDGE_MIN_TRAVEL_PX,
  CARD_DRAG_EDGE_ZONE_PX,
  cardDragEdgeDirection,
  cardDragEdgeSwitchDirection,
  CARD_SCROLL_MAX_VELOCITY_PX_PER_MS,
  CARD_SCROLL_MOMENTUM_TIME_CONSTANT_MS,
  CARD_SCROLL_RELEASE_IDLE_MS,
  scrollMomentumStep,
  scrollReleaseVelocity
} from '../../../../packages/svelte-kanban/src/directives/drag.js';

describe('cardDragEdgeDirection', () => {
  const left = 100;
  const right = 500;

  it('detects the previous-list zone at the left edge', () => {
    expect(cardDragEdgeDirection(left, left, right)).toBe('previous');
    expect(
      cardDragEdgeDirection(left + CARD_DRAG_EDGE_ZONE_PX, left, right)
    ).toBe('previous');
  });

  it('detects the next-list zone at the right edge', () => {
    expect(cardDragEdgeDirection(right, left, right)).toBe('next');
    expect(
      cardDragEdgeDirection(right - CARD_DRAG_EDGE_ZONE_PX, left, right)
    ).toBe('next');
  });

  it('does not switch lists in the board centre', () => {
    expect(cardDragEdgeDirection(300, left, right)).toBeNull();
  });
});

describe('cardDragEdgeSwitchDirection', () => {
  const left = 100;
  const right = 500;

  it('does not switch when a handle starts inside the edge zone', () => {
    const startX = right - 16;
    expect(cardDragEdgeSwitchDirection(startX, startX, left, right)).toBeNull();
    expect(
      cardDragEdgeSwitchDirection(
        startX + CARD_DRAG_EDGE_MIN_TRAVEL_PX - 1,
        startX,
        left,
        right
      )
    ).toBeNull();
  });

  it('switches after deliberate horizontal travel toward an edge', () => {
    expect(
      cardDragEdgeSwitchDirection(
        right,
        right - CARD_DRAG_EDGE_MIN_TRAVEL_PX,
        left,
        right
      )
    ).toBe('next');
    expect(
      cardDragEdgeSwitchDirection(
        left,
        left + CARD_DRAG_EDGE_MIN_TRAVEL_PX,
        left,
        right
      )
    ).toBe('previous');
  });

  it('ignores horizontal travel away from the active edge', () => {
    expect(
      cardDragEdgeSwitchDirection(
        right,
        right + CARD_DRAG_EDGE_MIN_TRAVEL_PX,
        left,
        right
      )
    ).toBeNull();
  });
});

describe('scrollMomentumStep', () => {
  it('continues in the release direction while slowing down', () => {
    const step = scrollMomentumStep(1, 100);
    expect(step.delta).toBeGreaterThan(0);
    expect(step.velocity).toBeGreaterThan(0);
    expect(step.velocity).toBeLessThan(1);

    const reverse = scrollMomentumStep(-1, 100);
    expect(reverse.delta).toBeCloseTo(-step.delta);
    expect(reverse.velocity).toBeCloseTo(-step.velocity);
  });

  it('coasts velocity times the time constant in total', () => {
    let velocity = 2;
    let travelled = 0;
    for (let frame = 0; frame < 600; frame += 1) {
      const step = scrollMomentumStep(velocity, 16);
      travelled += step.delta;
      velocity = step.velocity;
    }
    expect(travelled).toBeCloseTo(2 * CARD_SCROLL_MOMENTUM_TIME_CONSTANT_MS);
  });

  it('gives the same result for one long step as for many short ones', () => {
    const once = scrollMomentumStep(1.5, 64);
    let velocity = 1.5;
    let delta = 0;
    for (let i = 0; i < 4; i += 1) {
      const step = scrollMomentumStep(velocity, 16);
      delta += step.delta;
      velocity = step.velocity;
    }
    expect(delta).toBeCloseTo(once.delta);
    expect(velocity).toBeCloseTo(once.velocity);
  });
});

describe('scrollReleaseVelocity', () => {
  const flick = [
    { time: 0, top: 0 },
    { time: 16, top: 40 },
    { time: 32, top: 80 },
    { time: 48, top: 110 },
    // The finger slows down just before it lifts.
    { time: 64, top: 118 }
  ];

  it('averages the trailing window instead of trusting the last move', () => {
    const velocity = scrollReleaseVelocity(flick, 70);
    expect(velocity).toBeCloseTo(118 / 64);
    expect(velocity).toBeGreaterThan((118 - 110) / 16);
  });

  it('keeps the flick direction', () => {
    const upward = flick.map((sample) => ({ ...sample, top: -sample.top }));
    expect(scrollReleaseVelocity(upward, 70)).toBeCloseTo(-118 / 64);
  });

  it('ignores samples older than the window', () => {
    const samples = [
      { time: 0, top: 0 },
      { time: 400, top: 0 },
      { time: 450, top: 50 },
      { time: 500, top: 100 }
    ];
    expect(scrollReleaseVelocity(samples, 505)).toBeCloseTo(1);
  });

  it('does not fling when the finger rested before lifting', () => {
    expect(
      scrollReleaseVelocity(flick, 64 + CARD_SCROLL_RELEASE_IDLE_MS + 1)
    ).toBe(0);
  });

  it('caps runaway velocities', () => {
    const samples = [
      { time: 0, top: 0 },
      { time: 1, top: 500 }
    ];
    expect(scrollReleaseVelocity(samples, 2)).toBe(
      CARD_SCROLL_MAX_VELOCITY_PX_PER_MS
    );
  });

  it('returns zero without movement', () => {
    expect(scrollReleaseVelocity([], 0)).toBe(0);
    expect(scrollReleaseVelocity([{ time: 0, top: 0 }], 0)).toBe(0);
  });
});
