import { describe, expect, it } from 'vitest';
import { tokenizeWords } from './tokenize';

/**
 * These lock in the false-positive rules. Nearly every case below is a
 * squiggle a user would have reported as a bug, so a change that breaks
 * one of them is a regression in trust, not just in output.
 */

const words = (text: string) => tokenizeWords(text).map((t) => t.text);

describe('tokenizeWords', () => {
  it('splits plain prose on whitespace and punctuation', () => {
    expect(words('The quick brown fox.')).toEqual([
      'The',
      'quick',
      'brown',
      'fox'
    ]);
  });

  it('reports offsets into the original string', () => {
    expect(tokenizeWords('ab cd')).toEqual([
      { text: 'ab', from: 0, to: 2 },
      { text: 'cd', from: 3, to: 5 }
    ]);
  });

  it('rebases offsets by the segment offset', () => {
    expect(tokenizeWords('ab', 100)).toEqual([
      { text: 'ab', from: 100, to: 102 }
    ]);
  });

  describe('umlauts and ß', () => {
    // The Phase 0 dictionary harness failed exactly here when the encoding
    // was wrong, so it is worth asserting the tokenizer never truncates.
    it('keeps German letters inside the word', () => {
      expect(words('Die Straße war größer als gedacht')).toEqual([
        'Die',
        'Straße',
        'war',
        'größer',
        'als',
        'gedacht'
      ]);
    });

    it('keeps long compounds whole', () => {
      expect(words('Donaudampfschifffahrtsgesellschaft')).toEqual([
        'Donaudampfschifffahrtsgesellschaft'
      ]);
    });
  });

  describe('apostrophes', () => {
    it('keeps a straight apostrophe inside a word', () => {
      expect(words("don't")).toEqual(["don't"]);
    });

    it('keeps a typographic apostrophe inside a word', () => {
      expect(words('geht’s')).toEqual(['geht’s']);
    });

    it('drops quoting apostrophes around a word', () => {
      expect(words("'quoted'")).toEqual(['quoted']);
    });
  });

  describe('hyphens', () => {
    // Kept whole on purpose: Hunspell's BREAK directive splits these
    // internally, and splitting here would flag the `E` of `E-Mail`.
    it('keeps a hyphenated word as one token', () => {
      expect(words('E-Mail well-known')).toEqual(['E-Mail', 'well-known']);
    });

    it('does not absorb a dash used as punctuation', () => {
      expect(words('word - word')).toEqual(['word', 'word']);
    });
  });

  describe('things that are not words', () => {
    it('skips bare numbers', () => {
      expect(words('in 2026 and 42')).toEqual(['in', 'and']);
    });

    it('skips ordinals and versions', () => {
      expect(words('the 3rd release v1 and 1920x1080')).toEqual([
        'the',
        'release',
        'and'
      ]);
    });

    it('skips tokens containing digits', () => {
      expect(words('sha256 abc123')).toEqual([]);
    });

    it('splits snake_case on the underscore', () => {
      expect(words('max_retry_count')).toEqual(['max', 'retry', 'count']);
    });
  });

  describe('camelCase identifiers', () => {
    it('splits camelCase so each part can be checked', () => {
      expect(words('getUserName')).toEqual(['get', 'User', 'Name']);
    });

    it('splits an acronym prefix at the last capital', () => {
      expect(words('HTMLParser')).toEqual(['HTML', 'Parser']);
    });

    it('leaves ordinary capitalized words alone', () => {
      expect(words('Berlin')).toEqual(['Berlin']);
    });

    it('leaves all-caps acronyms alone', () => {
      expect(words('NASA')).toEqual(['NASA']);
    });

    it('reports correct offsets for split parts', () => {
      expect(tokenizeWords('getUser')).toEqual([
        { text: 'get', from: 0, to: 3 },
        { text: 'User', from: 3, to: 7 }
      ]);
    });

    it('leaves German capitalized nouns intact', () => {
      // Leading capital is not a camelCase boundary — otherwise every
      // German noun would be split.
      expect(words('Das Haus')).toEqual(['Das', 'Haus']);
    });
  });

  describe('scripts written without spaces', () => {
    it('skips CJK entirely rather than underlining whole sentences', () => {
      expect(words('これは日本語です')).toEqual([]);
    });

    it('skips Hangul', () => {
      expect(words('안녕하세요')).toEqual([]);
    });

    it('still checks Latin words mixed into CJK text', () => {
      expect(words('これは Markdown です')).toEqual(['Markdown']);
    });
  });

  describe('emoji and astral characters', () => {
    it('ignores emoji', () => {
      expect(words('nice 🎉 work')).toEqual(['nice', 'work']);
    });

    it('keeps offsets correct after an emoji', () => {
      // The emoji is a surrogate pair, so `work` starts at UTF-16 index 8.
      const [token] = tokenizeWords('🎉 work').slice(-1);
      expect(token).toEqual({ text: 'work', from: 3, to: 7 });
    });
  });

  it('returns nothing for empty or punctuation-only input', () => {
    expect(words('')).toEqual([]);
    expect(words('  ...  ')).toEqual([]);
  });
});

/**
 * Abbreviations. Hunspell dictionaries store these WITH the period —
 * de_DE_frami contains `Nr.`, `Dr.`, `bzw.` and ~94 others and does NOT
 * contain the bare stems — so stripping it flags every abbreviation in the
 * language and then suggests back the exact form the user typed.
 */
describe('trailing periods', () => {
  const abbrev = (text: string) =>
    tokenizeWords(text).map((token) => token.abbreviation);

  it('offers the abbreviation form when a period follows', () => {
    expect(tokenizeWords('Nr.')).toEqual([
      { text: 'Nr', from: 0, to: 2, abbreviation: 'Nr.' }
    ]);
  });

  it('offers it at the end of a sentence too', () => {
    // `gut` is known and `gut.` is not; the provider accepts either, so the
    // tokenizer does not need to decide which case this is.
    expect(abbrev('Das ist gut.')).toEqual([undefined, undefined, 'gut.']);
  });

  it('does not offer one when no period follows', () => {
    expect(abbrev('Nr 5')).toEqual([undefined]);
  });

  it('does not offer one across whitespace', () => {
    expect(abbrev('Nr .')).toEqual([undefined]);
  });

  it('attaches it to the last part of a split token only', () => {
    const tokens = tokenizeWords('getUser.');
    expect(tokens.map((t) => t.text)).toEqual(['get', 'User']);
    expect(tokens.map((t) => t.abbreviation)).toEqual([undefined, 'User.']);
  });

  it('keeps positions covering the word, not the period', () => {
    const [token] = tokenizeWords('Nr.');
    expect(token.to).toBe(2);
  });

  it('rebases correctly when the segment carries an offset', () => {
    // The period is found in the local string, while positions carry the
    // offset — mixing the two silently loses every abbreviation after the
    // first paragraph.
    expect(tokenizeWords('Nr.', 100)).toEqual([
      { text: 'Nr', from: 100, to: 102, abbreviation: 'Nr.' }
    ]);
  });

  it('handles a real German sentence of abbreviations', () => {
    const tokens = tokenizeWords('Siehe Nr. 5 bzw. Abs. 2');
    expect(
      tokens.filter((t) => t.abbreviation).map((t) => t.abbreviation)
    ).toEqual(['Nr.', 'bzw.', 'Abs.']);
  });
});

/**
 * WORDCHARS-driven joining. Hunspell has no tokenizer and exports this
 * directive so callers segment the way the dictionary expects; German,
 * Danish, French, Dutch and Swedish all declare `.`.
 */
describe('WORDCHARS', () => {
  const de = '\u00df-.';
  const words = (text: string, chars: string) =>
    tokenizeWords(text, 0, chars).map((t) => t.text);

  it('joins letters across a declared character', () => {
    expect(words('z.B', de)).toEqual(['z.B']);
  });

  it('does not join across a sentence boundary', () => {
    // `. ` ends a sentence; `.B` does not. This is the whole disambiguation.
    expect(words('Das ist gut. Aber', de)).toEqual([
      'Das',
      'ist',
      'gut',
      'Aber'
    ]);
  });

  it('still offers the abbreviation form for the joined token', () => {
    const [token] = tokenizeWords('z.B.', 0, de);
    expect(token.text).toBe('z.B');
    expect(token.abbreviation).toBe('z.B.');
  });

  it('ignores the directive when the dictionary declares none', () => {
    // en_US declares no `.`, so nothing joins.
    expect(words('z.B', '')).toEqual(['z', 'B']);
  });

  it('ignores letters and digits in the directive', () => {
    // They are already word characters; only punctuation changes anything.
    expect(words('ab', '0123456789')).toEqual(['ab']);
  });

  describe('segments as a fallback', () => {
    it('records the segments of a joined token', () => {
      const [token] = tokenizeWords('and/or', 0, '/');
      expect(token.text).toBe('and/or');
      expect(token.parts?.map((p) => p.text)).toEqual(['and', 'or']);
    });

    it('gives segments their own ranges', () => {
      const [token] = tokenizeWords('and/or', 0, '/');
      expect(token.parts).toEqual([
        { text: 'and', from: 0, to: 3 },
        { text: 'or', from: 4, to: 6 }
      ]);
    });

    it('does not split at a hyphen', () => {
      // E-Mail stays whole: Hunspell's BREAK handles hyphens better, and
      // splitting would flag `E` as a one-letter unknown.
      const [token] = tokenizeWords('E-Mail', 0, de);
      expect(token.text).toBe('E-Mail');
      expect(token.parts).toBeUndefined();
    });

    it('does not split at an apostrophe', () => {
      const [token] = tokenizeWords("don't", 0, "'");
      expect(token.parts).toBeUndefined();
    });

    it('records no segments for an ordinary word', () => {
      expect(tokenizeWords('Haus', 0, de)[0].parts).toBeUndefined();
    });

    it('rebases segment offsets', () => {
      const [token] = tokenizeWords('and/or', 100, '/');
      expect(token.parts?.map((p) => p.from)).toEqual([100, 104]);
    });
  });
});
