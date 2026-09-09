import { describe, expect, it, vi } from 'vitest';
import { createSpellcheckProvider } from './spellcheck-provider';
import type { CheckRequest } from './types';

const request = (
  text: string,
  over: Partial<CheckRequest> = {}
): CheckRequest => ({
  text,
  languages: ['de_DE_frami'],
  signal: new AbortController().signal,
  ...over
});

/** Backend stub: everything in `unknown` is a misspelling, nothing else is. */
const backend = (...unknown: string[]) =>
  vi.fn(async (_languages: string[], words: string[]) =>
    words.filter((word) => unknown.includes(word))
  );

const provider = (
  unknownWords: ReturnType<typeof backend>,
  isIgnored?: (word: string) => boolean,
  wordChars?: () => string
) =>
  createSpellcheckProvider({
    unknownWords,
    message: (word) => `unknown: ${word}`,
    isIgnored,
    wordChars
  });

describe('createSpellcheckProvider', () => {
  it('flags an unknown word at its position', async () => {
    const out = await provider(backend('Gescwindigkeit')).check(
      request('Die Gescwindigkeit war hoch')
    );
    expect(out).toEqual([
      {
        from: 4,
        to: 18,
        kind: 'spelling',
        message: 'unknown: Gescwindigkeit',
        replacements: [],
        source: 'spellcheck'
      }
    ]);
  });

  it('reports nothing when every word is known', async () => {
    expect(
      await provider(backend()).check(request('Die Straße war größer'))
    ).toEqual([]);
  });

  it('flags every occurrence of a repeated misspelling', async () => {
    const out = await provider(backend('teh')).check(
      request('teh cat and teh dog')
    );
    expect(out.map((d) => d.from)).toEqual([0, 12]);
  });

  it('sends each distinct word once', async () => {
    // A paragraph repeats words heavily; the IPC payload should not.
    const check = backend('teh');
    await provider(check).check(request('teh teh teh the'));
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0][1]).toEqual(['teh', 'the']);
  });

  it('leaves replacements empty — the popover fetches them on demand', async () => {
    const out = await provider(backend('teh')).check(request('teh'));
    expect(out[0].replacements).toEqual([]);
  });

  describe('short-circuits', () => {
    it('does not call the backend when no language is enabled', async () => {
      const check = backend('teh');
      expect(
        await provider(check).check(request('teh', { languages: [] }))
      ).toEqual([]);
      expect(check).not.toHaveBeenCalled();
    });

    it('does not call the backend for text with no words', async () => {
      const check = backend('teh');
      await provider(check).check(request('  ...  123  '));
      expect(check).not.toHaveBeenCalled();
    });

    it('discards results once the signal is aborted', async () => {
      const controller = new AbortController();
      const check = vi.fn(async (_l: string[], words: string[]) => {
        controller.abort();
        return words;
      });
      const out = await provider(check).check(
        request('teh', { signal: controller.signal })
      );
      expect(out).toEqual([]);
    });
  });

  describe('personal dictionary', () => {
    it('never sends an ignored word to the backend', async () => {
      const check = backend('Mindstream');
      const out = await provider(check, (word) => word === 'Mindstream').check(
        request('Mindstream ist gut')
      );
      expect(check.mock.calls[0][1]).not.toContain('Mindstream');
      expect(out).toEqual([]);
    });

    it('does not call the backend when every word is ignored', async () => {
      const check = backend('teh');
      await provider(check, () => true).check(request('teh teh'));
      expect(check).not.toHaveBeenCalled();
    });
  });

  it('checks identifiers part by part', async () => {
    // The joined form is asked about first and rejected, so the segments
    // decide: only the misspelled one is flagged, with a range covering
    // just that part.
    const out = await provider(backend('getUserNaem', 'Naem')).check(
      request('getUserNaem')
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ from: 7, to: 11 });
  });

  it('accepts an identifier the engine knows as a whole', async () => {
    // Nothing is decomposed until the joined form has been rejected, so a
    // compound the dictionary recognises is never second-guessed.
    const out = await provider(backend('Mindstream')).check(
      request('MindstreamNotes')
    );
    expect(out).toEqual([]);
  });
});

/**
 * The reported bug: adding `MindstreamNotes` to the personal dictionary
 * left it underlined, because the tokenizer split it before anything asked
 * whether the user had accepted it and the engine then rejected
 * `Mindstream` on its own. The LanguageTool provider was unaffected — it
 * matches whole ranges — which is what made the two checkers disagree.
 */
describe('personal dictionary and compound words', () => {
  const compound = (isIgnored: (word: string) => boolean) =>
    provider(backend('Mindstream', 'MindstreamNotes'), isIgnored);

  it('accepts a compound the user added as a whole', async () => {
    const out = await compound((word) => word === 'MindstreamNotes').check(
      request('MindstreamNotes ist gut')
    );
    expect(out).toEqual([]);
  });

  it('matches an added compound case-insensitively at the call site', async () => {
    // Folding lives in the personal dictionary; the provider must pass the
    // word through untouched for it to work.
    const seen: string[] = [];
    await compound((word) => {
      seen.push(word);
      return false;
    }).check(request('MindstreamNotes'));
    expect(seen).toContain('MindstreamNotes');
  });

  it('never sends an accepted compound to the backend', async () => {
    const check = backend('Mindstream', 'MindstreamNotes');
    await provider(check, (word) => word === 'MindstreamNotes').check(
      request('MindstreamNotes')
    );
    expect(check).not.toHaveBeenCalled();
  });

  it('accepts a compound whose unknown segment the user added', async () => {
    // Adding the word from the squiggle accepts the segment, not the
    // compound — that has to clear the compound too.
    const out = await compound((word) => word === 'Mindstream').check(
      request('MindstreamNotes')
    );
    expect(out).toEqual([]);
  });

  it('still flags the segment the user has not added', async () => {
    const out = await provider(
      backend('Mindstream', 'Naem', 'MindstreamNaem'),
      (word) => word === 'Mindstream'
    ).check(request('MindstreamNaem'));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ from: 10, to: 14 });
  });

  it('accepts a segment the user added inside a WORDCHARS-joined token', async () => {
    const out = await provider(
      backend('foo', 'foo/bar'),
      (word) => word === 'foo',
      () => '/'
    ).check(request('foo/bar'));
    expect(out).toEqual([]);
  });
});

/**
 * The reported bug: typing `Nr.` produced a squiggle under `Nr` and then
 * suggested `Nr.` — the form already on screen. `Nr` genuinely is not in
 * de_DE_frami; only `Nr.` is, along with ~96 other abbreviations.
 */
describe('abbreviations', () => {
  it('accepts a word whose abbreviation form is known', async () => {
    // Exactly the dictionary's shape: the stem is unknown, the abbreviation
    // is not.
    const out = await provider(backend('Nr')).check(request('Siehe Nr. 5'));
    expect(out).toEqual([]);
  });

  it('still flags a word when neither form is known', async () => {
    const out = await provider(backend('Xyz', 'Xyz.')).check(request('Xyz.'));
    expect(out).toHaveLength(1);
    // The range covers the word, never the period.
    expect(out[0]).toMatchObject({ from: 0, to: 3 });
  });

  it('still flags an ordinary misspelling at the end of a sentence', async () => {
    const out = await provider(backend('teh', 'teh.')).check(request('teh.'));
    expect(out).toHaveLength(1);
  });

  it('does not flag a correct word at the end of a sentence', async () => {
    // `gut` is known even though `gut.` is not.
    const out = await provider(backend('gut.')).check(request('Das ist gut.'));
    expect(out).toEqual([]);
  });

  it('offers both forms to the backend', async () => {
    const check = backend('Nr');
    await provider(check).check(request('Nr.'));
    expect(check.mock.calls[0][1]).toEqual(['Nr', 'Nr.']);
  });

  it('accepts an abbreviation held in the personal dictionary', async () => {
    // The user added "Nr." — matching only the stem would keep flagging it.
    const check = backend('Nr');
    const out = await provider(check, (word) => word === 'Nr.').check(
      request('Nr.')
    );
    expect(out).toEqual([]);
    expect(check).not.toHaveBeenCalled();
  });
});

/**
 * WORDCHARS joining, and the fallback that makes unioning it across
 * languages safe.
 */
describe('WORDCHARS-joined tokens', () => {
  const withChars = (unknownWords: ReturnType<typeof backend>, chars: string) =>
    createSpellcheckProvider({
      unknownWords,
      message: (word) => `unknown: ${word}`,
      wordChars: () => chars
    });

  it('accepts a joined construct the dictionary knows', async () => {
    // spellbook resolves z.B. via the .aff BREAK rules, so the whole form
    // is what has to reach it.
    const out = await withChars(backend('z', 'B'), '.').check(
      request('Siehe z.B. hier')
    );
    expect(out).toEqual([]);
  });

  it('offers the whole form, its abbreviation and its segments', async () => {
    // The last segment carries an abbreviation of its own: in `BestellNr.`
    // it is `Nr.` that the dictionary stores, and the fallback can only use
    // a form that was asked about.
    const check = backend('nothing');
    await withChars(check, '.').check(request('z.B.'));
    expect(check.mock.calls[0][1]).toEqual(['z.B', 'z.B.', 'z', 'B', 'B.']);
  });

  it('falls back to segments when no whole form is known', async () => {
    // Enabling Dutch declares `/` for every language, so `and/or` must not
    // become one unknown word in English text.
    const out = await withChars(backend('and/or'), '/').check(
      request('and/or')
    );
    expect(out).toEqual([]);
  });

  it('flags only the bad segment, with its own range', async () => {
    const out = await withChars(backend('gut/schlekt', 'schlekt'), '/').check(
      request('gut/schlekt')
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ from: 4, to: 11 });
  });

  it('flags the whole token when it has no segments', async () => {
    const out = await withChars(backend('Xyzzy'), '.').check(request('Xyzzy'));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ from: 0, to: 5 });
  });
});
