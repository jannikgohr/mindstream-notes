import { describe, expect, it } from 'vitest';
import {
  CARD_DRAG_EDGE_MIN_TRAVEL_PX,
  CARD_DRAG_EDGE_ZONE_PX,
  cardDragEdgeDirection,
  cardDragEdgeSwitchDirection,
  scrollMomentumStep
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
    expect(step.velocity).toBeCloseTo(0.6);

    const reverse = scrollMomentumStep(-1, 100);
    expect(reverse.delta).toBeLessThan(0);
    expect(reverse.velocity).toBeCloseTo(-0.6);
  });

  it('stops at zero instead of reversing direction', () => {
    expect(scrollMomentumStep(0.2, 100)).toEqual({
      delta: 10,
      velocity: 0
    });
  });
});
