import { describe, expect, it } from 'vitest';
import {
  commonPrefixLength,
  EDIT,
  editCost,
  rankSuggestions,
  TRANSPOSE
} from './suggestion-rank';

describe('editCost', () => {
  it('is zero for identical strings', () => {
    expect(editCost('Nr', 'Nr')).toBe(0);
  });

  it('counts a substitution, insertion and deletion as one edit each', () => {
    expect(editCost('Nr', 'Ne')).toBe(EDIT);
    expect(editCost('Nr', 'Nr.')).toBe(EDIT);
    expect(editCost('Nr', 'N')).toBe(EDIT);
  });

  it('prices a transposition below any other single edit', () => {
    // `teh` -> `the` must beat `teh` -> `ten`, which is one substitution
    // AND shares the longer prefix. Only the cheaper edit settles it.
    expect(editCost('teh', 'the')).toBe(TRANSPOSE);
    expect(editCost('teh', 'ten')).toBe(EDIT);
    expect(TRANSPOSE).toBeLessThan(EDIT);
  });

  it('treats a case change as a real edit', () => {
    // Load-bearing: folding case would make NR a perfect match for Nr.
    expect(editCost('Nr', 'NR')).toBe(EDIT);
  });

  it('handles empty input', () => {
    expect(editCost('', 'abc')).toBe(3 * EDIT);
    expect(editCost('abc', '')).toBe(3 * EDIT);
    expect(editCost('', '')).toBe(0);
  });

  it('handles German characters', () => {
    expect(editCost('Strasse', 'Straße')).toBe(2 * EDIT);
    expect(editCost('schon', 'schön')).toBe(EDIT);
  });
});

describe('commonPrefixLength', () => {
  it('measures the shared prefix', () => {
    expect(commonPrefixLength('Nr', 'Nr.')).toBe(2);
    expect(commonPrefixLength('Nr', 'NR')).toBe(1);
    expect(commonPrefixLength('Nr', 'Er')).toBe(0);
  });

  it('is case-sensitive', () => {
    expect(commonPrefixLength('nr', 'Nr')).toBe(0);
  });
});

describe('rankSuggestions', () => {
  it('puts the intended abbreviation first', () => {
    // The reported case, in the order spellbook actually emitted it.
    const ranked = rankSuggestions('Nr', [
      'NR',
      'R',
      'N',
      'Er',
      'Ne',
      'Ni',
      'Na',
      'Nr.'
    ]);
    expect(ranked[0]).toBe('Nr.');
  });

  it('ranks a transposition fix first', () => {
    expect(rankSuggestions('teh', ['ten', 'tea', 'the'])[0]).toBe('the');
  });

  it('prefers the closest word overall', () => {
    const ranked = rankSuggestions('Gescwindigkeit', [
      'Bitgeschwindigkeit',
      'Sinkgeschwindigkeit',
      'Geschwindigkeit'
    ]);
    expect(ranked[0]).toBe('Geschwindigkeit');
  });

  it('breaks cost ties by shared prefix', () => {
    // Every candidate is one substitution away; the prefix decides.
    const ranked = rankSuggestions('Haus', ['Maus', 'Haut', 'Raus']);
    expect(ranked[0]).toBe('Haut');
  });

  it('breaks remaining ties by the engine order, not alphabetically', () => {
    // Same distance, same prefix, same length — the engine's own weak
    // signal is better than re-sorting on something arbitrary.
    expect(rankSuggestions('Ne', ['Ni', 'Na'])).toEqual(['Ni', 'Na']);
  });

  it('prefers a similar length when cost and prefix tie', () => {
    const ranked = rankSuggestions('ab', ['abcde', 'abc']);
    expect(ranked[0]).toBe('abc');
  });

  it('returns an empty list unchanged', () => {
    expect(rankSuggestions('word', [])).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = ['b', 'a'];
    rankSuggestions('a', input);
    expect(input).toEqual(['b', 'a']);
  });

  it('keeps every suggestion', () => {
    const input = ['NR', 'R', 'N', 'Er', 'Nr.'];
    expect(rankSuggestions('Nr', input)).toHaveLength(input.length);
  });
});
