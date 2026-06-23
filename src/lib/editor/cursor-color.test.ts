import { describe, expect, it } from 'vitest';
import { pickCursorColor } from './cursor-color';

const HEX = /^#[0-9a-f]{6}$/;

describe('pickCursorColor', () => {
  it('always returns a palette hex colour', () => {
    for (const seed of ['alice', 'bob', '', 'a-very-long-username-123']) {
      expect(pickCursorColor(seed)).toMatch(HEX);
    }
  });

  it('is deterministic for the same seed', () => {
    expect(pickCursorColor('charlie')).toBe(pickCursorColor('charlie'));
  });

  it('spreads different seeds across the palette', () => {
    const seen = new Set(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(pickCursorColor)
    );
    // Not all identical — the hash distributes across colours.
    expect(seen.size).toBeGreaterThan(1);
  });
});
