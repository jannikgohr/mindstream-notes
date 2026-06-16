/**
 * Tests for the PDF in-document search index. These focus on the
 * offset-mapping and match-geometry logic — the part that's easy to get
 * subtly wrong and hard to eyeball in the running app. A fake page (a
 * plain object with `getTextContent`) stands in for a pdf.js page proxy.
 */

import { describe, expect, it } from 'vitest';
import {
  buildPageTextIndex,
  findMatchesInPage,
  type PageTextIndex
} from './pdf-text-index';

type FakeItem = {
  str: string;
  transform?: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
};

function fakePage(items: FakeItem[]) {
  return { getTextContent: async () => ({ items }) };
}

// transform = [a, b, c, d, e, f]; e,f is the item origin (x, baseline y).
function item(str: string, x: number, y: number, width: number): FakeItem {
  return { str, transform: [10, 0, 0, 10, x, y], width, height: 10 };
}

describe('buildPageTextIndex', () => {
  it('concatenates and lowercases text, recording per-item offsets', async () => {
    const index = await buildPageTextIndex(
      fakePage([item('Hello ', 0, 700, 60), item('World', 60, 700, 50)])
    );
    expect(index.text).toBe('hello world');
    expect(index.segments).toHaveLength(2);
    expect(index.segments[0]).toMatchObject({ start: 0, end: 6, x: 0 });
    expect(index.segments[1]).toMatchObject({ start: 6, end: 11, x: 60 });
  });

  it('inserts a separator between glued items but not into a segment', async () => {
    const index = await buildPageTextIndex(
      fakePage([item('foo', 0, 700, 30), item('bar', 40, 700, 30)])
    );
    // A space is synthesised so "foo" and "bar" stay separate words…
    expect(index.text).toBe('foo bar');
    // …but the separator is owned by no segment.
    expect(index.segments[1].start).toBe(4);
  });

  it('skips marked-content items that carry no string', async () => {
    const index = await buildPageTextIndex(
      fakePage([
        item('a', 0, 700, 10),
        { transform: [10, 0, 0, 10, 10, 700] } as FakeItem,
        item('b', 10, 700, 10)
      ])
    );
    expect(index.text).toBe('ab');
  });

  it('falls back to the transform font size when height is missing', async () => {
    const index = await buildPageTextIndex(
      fakePage([{ str: 'x', transform: [12, 0, 0, 12, 5, 700], width: 12 }])
    );
    expect(index.segments[0].height).toBeCloseTo(12);
  });
});

describe('findMatchesInPage', () => {
  const index: PageTextIndex = {
    text: 'the quick brown fox the',
    segments: [
      { start: 0, end: 23, x: 0, y: 700, width: 230, height: 10, length: 23 }
    ]
  };

  it('finds every non-overlapping, case-insensitive occurrence', () => {
    const matches = findMatchesInPage(index, 2, 'THE');
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.id)).toEqual(['2:0', '2:20']);
  });

  it('returns no matches for an empty query', () => {
    expect(findMatchesInPage(index, 0, '')).toEqual([]);
  });

  it('computes a rect positioned at the match offset', () => {
    const [match] = findMatchesInPage(index, 0, 'quick');
    expect(match.rects).toHaveLength(1);
    // "quick" starts at offset 4 of 23 chars across a 230-unit span:
    // x = 4 * (230 / 23) = 40, width = 5 * 10 = 50.
    expect(match.rects[0].x).toBeCloseTo(40);
    expect(match.rects[0].width).toBeCloseTo(50);
    expect(match.rects[0].y).toBe(700);
  });

  it('emits one rect per item a match spans', () => {
    const twoItems: PageTextIndex = {
      text: 'abcdef',
      segments: [
        { start: 0, end: 3, x: 0, y: 10, width: 30, height: 10, length: 3 },
        { start: 3, end: 6, x: 30, y: 10, width: 30, height: 10, length: 3 }
      ]
    };
    const [match] = findMatchesInPage(twoItems, 0, 'cd');
    expect(match.rects).toHaveLength(2);
  });
});
