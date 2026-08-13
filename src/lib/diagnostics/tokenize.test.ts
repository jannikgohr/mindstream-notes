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
