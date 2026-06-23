import { describe, expect, it } from 'vitest';
import {
  findMatches,
  mockSearchNotes,
  scoreNotes,
  splitByRanges,
  tokenizeQuery,
  type MatchableNote
} from './search-matcher';

const note = (
  title: string,
  body: string,
  tags: string[] = []
): MatchableNote => ({ title, body, tags });

describe('tokenizeQuery', () => {
  it('lowercases and splits on whitespace', () => {
    expect(tokenizeQuery('Hello World')).toEqual(['hello', 'world']);
  });

  it('collapses runs of whitespace and drops empties', () => {
    expect(tokenizeQuery('  foo   bar\tbaz\n')).toEqual(['foo', 'bar', 'baz']);
  });

  it('returns an empty array for blank input', () => {
    expect(tokenizeQuery('   ')).toEqual([]);
    expect(tokenizeQuery('')).toEqual([]);
  });
});

describe('findMatches', () => {
  it('finds all case-insensitive occurrences', () => {
    expect(findMatches('Foo foo FOO', ['foo'])).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 }
    ]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(findMatches('hello', ['xyz'])).toEqual([]);
  });

  it('returns an empty array for empty haystack or terms', () => {
    expect(findMatches('', ['foo'])).toEqual([]);
    expect(findMatches('foo', [])).toEqual([]);
  });

  it('merges overlapping ranges from multiple terms', () => {
    // "ab" -> [0,2], "bc" -> [1,3] overlap and merge into [0,3].
    expect(findMatches('abc', ['ab', 'bc'])).toEqual([{ start: 0, end: 3 }]);
  });

  it('merges adjacent ranges that touch', () => {
    // "ab" -> [0,2], "cd" -> [2,4]; s <= ce (2 <= 2) so they merge.
    expect(findMatches('abcd', ['ab', 'cd'])).toEqual([{ start: 0, end: 4 }]);
  });

  it('keeps disjoint ranges separate and sorted', () => {
    expect(findMatches('a__b', ['b', 'a'])).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 4 }
    ]);
  });
});

describe('splitByRanges', () => {
  it('returns the whole string unhighlighted when no ranges', () => {
    expect(splitByRanges('hello', [])).toEqual([
      { text: 'hello', highlight: false }
    ]);
  });

  it('splits around a single interior range', () => {
    expect(splitByRanges('abcde', [{ start: 1, end: 3 }])).toEqual([
      { text: 'a', highlight: false },
      { text: 'bc', highlight: true },
      { text: 'de', highlight: false }
    ]);
  });

  it('handles a range at the very start with no leading segment', () => {
    expect(splitByRanges('abc', [{ start: 0, end: 1 }])).toEqual([
      { text: 'a', highlight: true },
      { text: 'bc', highlight: false }
    ]);
  });

  it('handles a range running to the end with no trailing segment', () => {
    expect(splitByRanges('abc', [{ start: 1, end: 3 }])).toEqual([
      { text: 'a', highlight: false },
      { text: 'bc', highlight: true }
    ]);
  });

  it('handles multiple ranges', () => {
    expect(
      splitByRanges('a-b-c', [
        { start: 0, end: 1 },
        { start: 2, end: 3 }
      ])
    ).toEqual([
      { text: 'a', highlight: true },
      { text: '-', highlight: false },
      { text: 'b', highlight: true },
      { text: '-c', highlight: false }
    ]);
  });
});

describe('scoreNotes', () => {
  it('returns nothing for a blank query', () => {
    expect(scoreNotes([note('a', 'b')], '   ')).toEqual([]);
  });

  it('requires every term to be present (AND semantics)', () => {
    const notes = [note('alpha beta', 'body'), note('alpha only', 'body')];
    const out = scoreNotes(notes, 'alpha beta');
    expect(out).toHaveLength(1);
    expect(out[0].note.title).toBe('alpha beta');
  });

  it('matches terms across title, body and tags', () => {
    const notes = [note('alpha', 'gamma text', ['beta'])];
    const out = scoreNotes(notes, 'alpha beta gamma');
    expect(out).toHaveLength(1);
  });

  it('scores title hits at 10 and body hits at 1, ranking title higher', () => {
    const titleHit = note('needle', 'nothing here');
    const bodyHit = note('plain', 'needle needle needle');
    const out = scoreNotes([bodyHit, titleHit], 'needle');
    expect(out[0].note).toBe(titleHit);
    expect(out[0].score).toBe(10);
    expect(out[1].note).toBe(bodyHit);
    expect(out[1].score).toBe(3);
  });

  it('breaks score ties by most-recently-modified', () => {
    const older = { ...note('x needle', 'b'), modified: '2020-01-01' };
    const newer = { ...note('y needle', 'b'), modified: '2024-01-01' };
    const out = scoreNotes([older, newer], 'needle');
    expect(out.map((r) => (r.note as { modified: string }).modified)).toEqual([
      '2024-01-01',
      '2020-01-01'
    ]);
  });

  it('builds a snippet with an ellipsis prefix when the match is deep in the body', () => {
    const body = `${'x'.repeat(100)} needle tail`;
    const out = scoreNotes([note('t', body)], 'needle');
    expect(out[0].snippet.startsWith('…')).toBe(true);
    expect(out[0].snippet).toContain('needle');
    expect(out[0].snippetMatches.length).toBeGreaterThan(0);
  });

  it('omits the leading ellipsis when the match is near the start', () => {
    const out = scoreNotes([note('t', 'needle right away')], 'needle');
    expect(out[0].snippet.startsWith('…')).toBe(false);
  });
});

describe('mockSearchNotes', () => {
  it('maps scored notes into SearchHit shape', () => {
    const hits = mockSearchNotes(
      [note('needle title', 'needle body')],
      'needle'
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toHaveProperty('snippet');
    expect(hits[0]).toHaveProperty('title_matches');
    expect(hits[0]).toHaveProperty('snippet_matches');
    expect(hits[0].title_matches.length).toBeGreaterThan(0);
  });

  it('returns an empty list when no note matches', () => {
    expect(mockSearchNotes([note('a', 'b')], 'zzz')).toEqual([]);
  });
});
