import { describe, expect, it } from 'vitest';
import {
  CARD_DRAG_EDGE_ZONE_PX,
  cardDragEdgeDirection
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
