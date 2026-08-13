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
  isIgnored?: (word: string) => boolean
) =>
  createSpellcheckProvider({
    unknownWords,
    message: (word) => `unknown: ${word}`,
    isIgnored
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
    // camelCase is split by the tokenizer, so only the misspelled part is
    // flagged and the range covers just that part.
    const out = await provider(backend('Naem')).check(request('getUserNaem'));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ from: 7, to: 11 });
  });
});
