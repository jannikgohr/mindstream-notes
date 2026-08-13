import { describe, expect, it } from 'vitest';
import {
  excludeIgnored,
  ignoreRanges,
  mergeRanges,
  overlapsAny
} from './ignore-ranges';
import { tokenizeWords } from './tokenize';

/**
 * Asserted through the real pipeline — tokenize, then drop anything inside
 * an ignored region — because that composition is what actually decides
 * whether a squiggle appears. Testing the raw ranges would pass while the
 * two halves disagreed about offsets.
 */
const checked = (md: string) =>
  excludeIgnored(tokenizeWords(md), ignoreRanges(md)).map((t) => t.text);

describe('mergeRanges', () => {
  it('coalesces overlapping ranges', () => {
    expect(
      mergeRanges([
        { from: 5, to: 10 },
        { from: 0, to: 6 }
      ])
    ).toEqual([{ from: 0, to: 10 }]);
  });

  it('coalesces touching ranges', () => {
    expect(
      mergeRanges([
        { from: 0, to: 5 },
        { from: 5, to: 8 }
      ])
    ).toEqual([{ from: 0, to: 8 }]);
  });

  it('keeps disjoint ranges apart', () => {
    const input = [
      { from: 6, to: 8 },
      { from: 0, to: 5 }
    ];
    expect(mergeRanges(input)).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 8 }
    ]);
  });

  it('does not mutate its input', () => {
    const input = [{ from: 0, to: 5 }];
    mergeRanges(input);
    expect(input).toEqual([{ from: 0, to: 5 }]);
  });
});

describe('overlapsAny', () => {
  const ranges = [{ from: 10, to: 20 }];

  it('is false for a range that only touches the boundary', () => {
    expect(overlapsAny({ from: 5, to: 10 }, ranges)).toBe(false);
    expect(overlapsAny({ from: 20, to: 25 }, ranges)).toBe(false);
  });

  it('is true for any real overlap', () => {
    expect(overlapsAny({ from: 9, to: 11 }, ranges)).toBe(true);
    expect(overlapsAny({ from: 12, to: 14 }, ranges)).toBe(true);
  });
});

describe('code', () => {
  it('ignores fenced code blocks', () => {
    const md = ['before', '```js', 'const notaword = 1;', '```', 'after'].join(
      '\n'
    );
    expect(checked(md)).toEqual(['before', 'after']);
  });

  it('ignores tilde fences', () => {
    const md = ['before', '~~~', 'notaword', '~~~', 'after'].join('\n');
    expect(checked(md)).toEqual(['before', 'after']);
  });

  it('does not let a backtick fence close a tilde block', () => {
    const md = ['~~~', 'notaword', '```', 'alsonotaword', '~~~', 'after'].join(
      '\n'
    );
    expect(checked(md)).toEqual(['after']);
  });

  it('ignores an unterminated fence to the end of the document', () => {
    const md = ['before', '```', 'notaword', 'stillnotaword'].join('\n');
    expect(checked(md)).toEqual(['before']);
  });

  it('ignores inline code', () => {
    expect(checked('run `npmm instal` now')).toEqual(['run', 'now']);
  });

  it('honours the length of the opening backtick run', () => {
    expect(checked('a ``code with ` tick`` b')).toEqual(['a', 'b']);
  });
});

describe('frontmatter', () => {
  it('ignores YAML frontmatter at the top of the document', () => {
    const md = ['---', 'titel: notaword', '---', 'body'].join('\n');
    expect(checked(md)).toEqual(['body']);
  });

  it('treats a --- later in the document as a thematic break', () => {
    const md = ['intro', '---', 'body'].join('\n');
    expect(checked(md)).toEqual(['intro', 'body']);
  });
});

describe('math', () => {
  it('ignores inline math', () => {
    expect(checked('let $x_i$ be')).toEqual(['let', 'be']);
  });

  it('ignores block math', () => {
    expect(checked('a $$\\frac{aa}{bb}$$ b')).toEqual(['a', 'b']);
  });
});

describe('links, URLs and mentions', () => {
  it('checks link text but not the destination', () => {
    expect(checked('see [the docs](https://exampl.com/pagge)')).toEqual([
      'see',
      'the',
      'docs'
    ]);
  });

  it('ignores bare URLs', () => {
    expect(checked('go to https://exampl.com/pagge now')).toEqual([
      'go',
      'to',
      'now'
    ]);
  });

  it('ignores www URLs', () => {
    expect(checked('at www.exampl.com today')).toEqual(['at', 'today']);
  });

  it('ignores email addresses', () => {
    expect(checked('mail jannik@exampl.com please')).toEqual([
      'mail',
      'please'
    ]);
  });

  it('ignores reference definitions but not their labels', () => {
    expect(checked('[docs]: https://exampl.com/pagge')).toEqual(['docs']);
  });

  it('ignores wikilink targets', () => {
    expect(checked('as in [[Meeting Notiz]] here')).toEqual([
      'as',
      'in',
      'here'
    ]);
  });

  it('ignores @mentions', () => {
    expect(checked('ask @jannikg about it')).toEqual(['ask', 'about', 'it']);
  });

  it('ignores inline HTML tags but checks their text', () => {
    expect(checked('a <span class="hilite">word</span> b')).toEqual([
      'a',
      'word',
      'b'
    ]);
  });
});

describe('prose is left alone', () => {
  it('keeps ordinary text, including German', () => {
    expect(checked('Die Straße war größer als gedacht.')).toEqual([
      'Die',
      'Straße',
      'war',
      'größer',
      'als',
      'gedacht'
    ]);
  });

  it('keeps emphasis and heading markers out of the way', () => {
    expect(checked('## A **bold** claim')).toEqual(['A', 'bold', 'claim']);
  });

  it('returns no ranges for plain prose', () => {
    expect(ignoreRanges('just some words')).toEqual([]);
  });
});
