import { describe, expect, it, vi } from 'vitest';
import {
  categoryToKind,
  createLanguageToolProvider,
  type LanguageToolMatch
} from './languagetool-provider';
import type { CheckRequest } from './types';

const request = (
  text: string,
  over: Partial<CheckRequest> = {}
): CheckRequest => ({
  text,
  languages: ['en_US'],
  signal: new AbortController().signal,
  ...over
});

const match = (over: Partial<LanguageToolMatch> = {}): LanguageToolMatch => ({
  from: 0,
  to: 4,
  message: 'x',
  replacements: [],
  category: 'GRAMMAR',
  ...over
});

const CONFIG = {
  endpoint: 'http://localhost:8081',
  language: 'auto',
  disabledCategories: ['TYPOS']
};

const provider = (
  matches: LanguageToolMatch[],
  config: (() => typeof CONFIG | null) | null = null
) => {
  const check = vi.fn(async () => matches);
  return {
    check,
    provider: createLanguageToolProvider({
      id: 'plugins.com.example.lt.grammar',
      kinds: ['grammar', 'style'],
      config: config ?? (() => CONFIG),
      check
    })
  };
};

describe('categoryToKind', () => {
  it('maps style categories to style', () => {
    expect(categoryToKind('STYLE')).toBe('style');
    expect(categoryToKind('REDUNDANCY')).toBe('style');
  });

  it('maps anything else to grammar', () => {
    expect(categoryToKind('PUNCTUATION')).toBe('grammar');
    expect(categoryToKind('SOMETHING_NEW')).toBe('grammar');
  });

  it('discards spelling', () => {
    // The built-in dictionary owns spelling. The plugin disables TYPOS
    // server-side; this is the second line of defence, so a misconfigured
    // server cannot produce a second, disagreeing squiggle on one word.
    expect(categoryToKind('TYPOS')).toBeNull();
  });
});

describe('createLanguageToolProvider', () => {
  it('converts a match into a diagnostic', async () => {
    const { provider: p } = provider([
      match({ from: 4, to: 9, message: 'Use a comma.', replacements: ['a,'] })
    ]);
    expect(await p.check(request('some text here'))).toEqual([
      {
        from: 4,
        to: 9,
        kind: 'grammar',
        message: 'Use a comma.',
        replacements: ['a,'],
        source: 'plugins.com.example.lt.grammar'
      }
    ]);
  });

  it('keeps the server ranking of replacements', async () => {
    // LanguageTool ranks by rule confidence, which cannot be reconstructed
    // from the strings, so these are never re-sorted the way the
    // dictionary's suggestions are.
    const { provider: p } = provider([
      match({ replacements: ['zebra', 'apple', 'mango'] })
    ]);
    const [diagnostic] = await p.check(request('text'));
    expect(diagnostic.replacements).toEqual(['zebra', 'apple', 'mango']);
  });

  it('drops spelling findings', async () => {
    const { provider: p } = provider([match({ category: 'TYPOS' })]);
    expect(await p.check(request('text'))).toEqual([]);
  });

  describe('when it should stay quiet', () => {
    it('does nothing without a configured endpoint', async () => {
      // An unset server must read as "no opinion", not as an error on every
      // paragraph of every note.
      const { check, provider: p } = provider([match()], () => null);
      expect(await p.check(request('some text'))).toEqual([]);
      expect(check).not.toHaveBeenCalled();
    });

    it('does not spend a round trip on blank text', async () => {
      const { check, provider: p } = provider([match()]);
      await p.check(request('   \n  '));
      expect(check).not.toHaveBeenCalled();
    });

    it('discards results once the signal is aborted', async () => {
      const controller = new AbortController();
      const check = vi.fn(async () => {
        controller.abort();
        return [match()];
      });
      const p = createLanguageToolProvider({
        id: 'lt',
        kinds: ['grammar'],
        config: () => CONFIG,
        check
      });
      expect(
        await p.check(request('text', { signal: controller.signal }))
      ).toEqual([]);
    });
  });

  it('passes the endpoint, language and disabled categories through', async () => {
    const { check, provider: p } = provider([]);
    await p.check(request('some text'));
    expect(check).toHaveBeenCalledWith({
      endpoint: 'http://localhost:8081',
      language: 'auto',
      disabledCategories: ['TYPOS'],
      text: 'some text'
    });
  });

  it('declares the kinds it may emit', () => {
    expect(provider([]).provider.kinds).toEqual(['grammar', 'style']);
  });
});
