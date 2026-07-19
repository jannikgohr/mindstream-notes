import { describe, expect, it } from 'vitest';
import {
  horizontalInsertionIndex,
  moveItemToIndex
} from './horizontal-reorder';

function element(id: string, left: number, width = 40): HTMLElement {
  return {
    dataset: { reorderId: id },
    getBoundingClientRect: () =>
      ({
        left,
        right: left + width,
        width,
        top: 0,
        bottom: 0,
        height: 0,
        x: left,
        y: 0,
        toJSON: () => ({})
      }) as DOMRect
  } as unknown as HTMLElement;
}

describe('horizontal reorder helpers', () => {
  it('moves an item to a clamped index', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(moveItemToIndex(items, 'a', 2).map((item) => item.id)).toEqual([
      'b',
      'c',
      'a'
    ]);
    expect(moveItemToIndex(items, 'c', -1).map((item) => item.id)).toEqual([
      'c',
      'a',
      'b'
    ]);
  });

  it('computes insertion index from visible item midpoints', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const elements = [element('a', 0), element('b', 50), element('c', 100)];

    expect(horizontalInsertionIndex(items, 'a', elements, 40)).toBe(0);
    expect(horizontalInsertionIndex(items, 'a', elements, 80)).toBe(1);
    expect(horizontalInsertionIndex(items, 'a', elements, 140)).toBe(2);
  });

  it('skips visible items that do not have a measured element', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const elements = [element('c', 100)];

    expect(horizontalInsertionIndex(items, 'a', elements, 80)).toBe(1);
  });

  it('returns a shallow copy when the source item is missing', () => {
    const items = [{ id: 'a' }, { id: 'b' }];

    const next = moveItemToIndex(items, 'missing', 0);

    expect(next).toEqual(items);
    expect(next).not.toBe(items);
  });
});
