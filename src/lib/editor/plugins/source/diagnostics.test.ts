import { describe, expect, it } from 'vitest';
import { splitParagraphs } from './diagnostics';

/**
 * Segmentation for the source surface. The invariant that matters is the
 * same one the prose plugin has to hold: `from` must be the exact offset of
 * the segment's first character, because a provider's in-segment position is
 * added straight to it. A one-character drift puts every squiggle in the
 * paragraph on the wrong word.
 */
const roundTrips = (text: string) =>
  splitParagraphs(text).every((s) => text.slice(s.from, s.to) === s.text);

describe('splitParagraphs', () => {
  it('returns one segment for a single paragraph', () => {
    expect(splitParagraphs('one line')).toEqual([
      { text: 'one line', from: 0, to: 8 }
    ]);
  });

  it('splits on a blank line', () => {
    expect(splitParagraphs('first\n\nsecond').map((s) => s.text)).toEqual([
      'first',
      'second'
    ]);
  });

  it('keeps wrapped lines in one segment', () => {
    // A sentence split across two lines must stay one segment, or a grammar
    // checker sees two fragments instead of a sentence.
    expect(
      splitParagraphs('a sentence\nwrapped here').map((s) => s.text)
    ).toEqual(['a sentence\nwrapped here']);
  });

  it('anchors every segment at its own offset', () => {
    const text = 'first\n\nsecond\n\nthird';
    expect(splitParagraphs(text).map((s) => s.from)).toEqual([0, 7, 15]);
    expect(roundTrips(text)).toBe(true);
  });

  it('round-trips through blank lines of varying width', () => {
    const text = 'a\n\n\n\nb\n \nc';
    expect(roundTrips(text)).toBe(true);
    expect(splitParagraphs(text).map((s) => s.text)).toEqual(['a', 'b', 'c']);
  });

  it('treats a whitespace-only line as a separator', () => {
    expect(splitParagraphs('a\n   \nb').map((s) => s.text)).toEqual(['a', 'b']);
  });

  it('ignores leading and trailing blank lines', () => {
    const text = '\n\nbody\n\n';
    expect(splitParagraphs(text).map((s) => s.text)).toEqual(['body']);
    expect(roundTrips(text)).toBe(true);
  });

  it('returns nothing for empty or blank input', () => {
    expect(splitParagraphs('')).toEqual([]);
    expect(splitParagraphs('\n\n  \n')).toEqual([]);
  });

  it('round-trips a realistic note', () => {
    const text = [
      '# Titel',
      '',
      'Ein Absatz mit einem',
      'Zeilenumbruch.',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      'Letzter Absatz.'
    ].join('\n');
    expect(roundTrips(text)).toBe(true);
  });
});
