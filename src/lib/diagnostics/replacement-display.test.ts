import { describe, expect, it } from 'vitest';
import {
  needsWhitespaceMarkers,
  replacementParts
} from './replacement-display';

/**
 * The reported bug: a punctuation rule offered two suggestions that looked
 * identical, one of them rendering as a tofu box, because they differed
 * only in which space character they used.
 */
const NBSP = String.fromCharCode(0x00a0);
const NNBSP = String.fromCharCode(0x202f);

describe('replacementParts', () => {
  it('leaves an ordinary word alone', () => {
    expect(replacementParts('Geschwindigkeit')).toEqual([
      { text: 'Geschwindigkeit' }
    ]);
  });

  it('marks a plain space', () => {
    expect(replacementParts(': Google')).toEqual([
      { text: ':' },
      { text: '·', space: 'space' },
      { text: 'Google' }
    ]);
  });

  it('tells two space characters apart', () => {
    // The actual bug: these two rendered the same.
    const plain = replacementParts(': Google');
    const narrow = replacementParts(':' + NNBSP + 'Google');
    expect(plain).not.toEqual(narrow);
    expect(narrow[1]).toEqual({ text: '⍽', space: 'narrow no-break space' });
  });

  it('names a no-break space so the choice is explainable', () => {
    expect(replacementParts('a' + NBSP + 'b')[1]).toEqual({
      text: '⍽',
      space: 'no-break space'
    });
  });

  it('keeps adjacent spaces separate', () => {
    // A run of two different spaces must not merge into one blob.
    const parts = replacementParts(' ' + NBSP);
    expect(parts.map((p) => p.space)).toEqual(['space', 'no-break space']);
  });

  it('handles a replacement that is only whitespace', () => {
    expect(replacementParts(' ')).toEqual([{ text: '·', space: 'space' }]);
  });

  it('handles an empty replacement', () => {
    expect(replacementParts('')).toEqual([]);
  });

  it('preserves order across mixed content', () => {
    const parts = replacementParts('zu Hause');
    expect(parts.map((p) => p.text).join('')).toBe('zu·Hause');
  });
});

describe('needsWhitespaceMarkers', () => {
  it('is false for a plain word', () => {
    expect(needsWhitespaceMarkers('Geschwindigkeit')).toBe(false);
  });

  it('is true once any space is involved', () => {
    expect(needsWhitespaceMarkers(': Google')).toBe(true);
    expect(needsWhitespaceMarkers('a' + NNBSP + 'b')).toBe(true);
  });
});
