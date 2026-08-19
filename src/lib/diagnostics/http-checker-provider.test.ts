import { describe, expect, it, vi } from 'vitest';
import {
  categoryToKind,
  createHttpCheckerProvider,
  planChunks,
  type CategoryKinds,
  type CheckerMatch
} from './http-checker-provider';
import type { CheckRequest } from './types';
import type { PluginCheckerProtocol } from '$lib/plugins/types';

/**
 * A protocol stands in for the manifest a plugin would ship. Its contents do
 * not matter here — the provider never interprets it, it only carries it to
 * the host request — but it must be present, because a missing one is the
 * failure that would silently return no findings.
 */
const PROTOCOL = {
  check: {
    path: '/v2/check',
    encoding: 'form',
    fields: { text: 'text' }
  },
  matches: {
    list: '/matches',
    offset: '/offset',
    length: '/length',
    message: '/message'
  }
} as PluginCheckerProtocol;

/** LanguageTool's mapping, as its manifest now declares it. */
const KINDS: CategoryKinds = {
  map: { TYPOS: 'spelling', STYLE: 'style', REDUNDANCY: 'style' },
  fallback: 'grammar'
};

const request = (
  text: string,
  over: Partial<CheckRequest> = {}
): CheckRequest => ({
  text,
  languages: ['en_US'],
  signal: new AbortController().signal,
  ...over
});

const match = (over: Partial<CheckerMatch> = {}): CheckerMatch => ({
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
  disabledCategories: ['TYPOS'],
  preferredVariants: ['de-DE', 'en-US'],
  protocol: PROTOCOL
};

const provider = (
  matches: CheckerMatch[],
  config: (() => typeof CONFIG | null) | null = null,
  isIgnored?: (word: string) => boolean
) => {
  const check = vi.fn(async () => matches);
  return {
    check,
    provider: createHttpCheckerProvider({
      id: 'plugins.com.example.lt.grammar',
      kinds: ['grammar', 'style', 'spelling'],
      categoryKinds: KINDS,
      config: config ?? (() => CONFIG),
      isIgnored,
      check
    })
  };
};

describe('categoryToKind', () => {
  it('maps style categories to style', () => {
    expect(categoryToKind('STYLE', KINDS)).toBe('style');
    expect(categoryToKind('REDUNDANCY', KINDS)).toBe('style');
  });

  it('maps anything else to grammar', () => {
    expect(categoryToKind('PUNCTUATION', KINDS)).toBe('grammar');
    expect(categoryToKind('SOMETHING_NEW', KINDS)).toBe('grammar');
  });

  it('maps TYPOS to spelling', () => {
    // Whether these are SHOWN is settled by kind ownership in the bus; the
    // mapping itself is unconditional.
    expect(categoryToKind('TYPOS', KINDS)).toBe('spelling');
  });
});

describe('createHttpCheckerProvider', () => {
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
    const [diagnostic] = (await p.check(request('text'))) ?? [];
    expect(diagnostic.replacements).toEqual(['zebra', 'apple', 'mango']);
  });

  it('emits spelling findings so its ranking can be used', async () => {
    const { provider: p } = provider([match({ category: 'TYPOS' })]);
    const [diagnostic] = (await p.check(request('text'))) ?? [];
    expect(diagnostic.kind).toBe('spelling');
  });

  it('drops a spelling finding for a word in the personal dictionary', async () => {
    // The check API has no per-request word list, so this has to happen
    // client-side or "Add to dictionary" would silently do nothing.
    const { provider: p } = provider(
      [match({ from: 0, to: 10, category: 'TYPOS' })],
      null,
      (word) => word === 'Mindstream'
    );
    expect(await p.check(request('Mindstream ist gut'))).toEqual([]);
  });

  it('keeps a grammar finding even for an accepted word', async () => {
    // The personal dictionary says how a word is spelled, not how it is used.
    const { provider: p } = provider(
      [match({ from: 0, to: 10, category: 'GRAMMAR' })],
      null,
      () => true
    );
    expect(await p.check(request('Mindstream ist gut'))).toHaveLength(1);
  });

  describe('when it should stay quiet', () => {
    it('does nothing without a configured endpoint', async () => {
      // An unset server must read as "no opinion", not as an error on every
      // paragraph of every note.
      // null, not [] — an empty array would read as "nothing is wrong" and,
      // once this provider owns spelling, would suppress the dictionary.
      const { check, provider: p } = provider([match()], () => null);
      expect(await p.check(request('some text'))).toBeNull();
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
      const p = createHttpCheckerProvider({
        id: 'lt',
        kinds: ['grammar'],
        categoryKinds: KINDS,
        config: () => CONFIG,
        check
      });
      expect(
        await p.check(request('text', { signal: controller.signal }))
      ).toBeNull();
    });
  });

  it('passes the endpoint, language and disabled categories through', async () => {
    const { check, provider: p } = provider([]);
    await p.check(request('some text'));
    expect(check).toHaveBeenCalledWith({
      endpoint: 'http://localhost:8081',
      language: 'auto',
      disabledCategories: ['TYPOS'],
      preferredVariants: ['de-DE', 'en-US'],
      // The declared wire format rides along with every request rather than
      // being captured once, so a plugin update cannot leave a stale one.
      protocol: PROTOCOL,
      text: 'some text'
    });
  });

  it('declares the kinds it may emit', () => {
    expect(provider([]).provider.kinds).toEqual([
      'grammar',
      'style',
      'spelling'
    ]);
  });
});

/**
 * Status reporting. A checker that contributes nothing looks exactly like a
 * clean document, so its real state has to come from the pipeline rather
 * than from a button the user must think to press.
 */
describe('status reporting', () => {
  const withStatus = (
    matches: CheckerMatch[],
    config: (() => typeof CONFIG | null) | null = null,
    check?: () => Promise<CheckerMatch[]>
  ) => {
    const seen: { state: string; detail?: string }[] = [];
    const provider = createHttpCheckerProvider({
      id: 'lt',
      kinds: ['grammar', 'spelling'],
      categoryKinds: KINDS,
      config: config ?? (() => CONFIG),
      check: check ?? (async () => matches),
      onStatus: (state, detail) => seen.push({ state, detail })
    });
    return { seen, provider };
  };

  it('reports unconfigured when there is no server URL', async () => {
    const { seen, provider: p } = withStatus([], () => null);
    await p.check(request('some text'));
    expect(seen).toEqual([{ state: 'unconfigured', detail: undefined }]);
  });

  it('reports active after a successful run', async () => {
    const { seen, provider: p } = withStatus([]);
    await p.check(request('some text'));
    expect(seen).toEqual([{ state: 'active', detail: undefined }]);
  });

  it('reports the failure reason, then rethrows', async () => {
    // The bus turns a throw into "skipped for this segment", which is
    // invisible on its own — so it is reported before it propagates.
    const { seen, provider: p } = withStatus([], null, async () => {
      throw new Error('connection refused');
    });
    await expect(p.check(request('some text'))).rejects.toThrow(
      'connection refused'
    );
    expect(seen).toEqual([{ state: 'failed', detail: 'connection refused' }]);
  });

  it('says nothing about a segment it skipped', async () => {
    // Blank text is not evidence either way.
    const { seen, provider: p } = withStatus([]);
    await p.check(request('   '));
    expect(seen).toEqual([]);
  });
});

/**
 * Batching. Per-paragraph checking made a long note take minutes: measured
 * against a real server a request costs ~2.4s almost regardless of size, so
 * the round trips dominated. The browser add-on batches for the same reason.
 *
 * The risk batching introduces is offset arithmetic — a match is reported
 * against the joined chunk and has to come back to the right segment.
 */
describe('planChunks', () => {
  const seg = (text: string) => ({ text });

  it('joins segments into one chunk when they fit', () => {
    const chunks = planChunks([seg('one'), seg('two')], 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('one\n\ntwo');
  });

  it('records where each segment starts in the joined text', () => {
    const [chunk] = planChunks([seg('one'), seg('two')], 100);
    expect(chunk.entries).toEqual([
      { index: 0, at: 0, length: 3 },
      { index: 1, at: 5, length: 3 }
    ]);
    // The recorded offset must actually locate the segment.
    for (const e of chunk.entries) {
      expect(chunk.text.slice(e.at, e.at + e.length)).toBe(
        ['one', 'two'][e.index]
      );
    }
  });

  it('splits once the limit is reached', () => {
    const chunks = planChunks([seg('a'.repeat(60)), seg('b'.repeat(60))], 100);
    expect(chunks).toHaveLength(2);
  });

  it('keeps an oversized paragraph whole', () => {
    // Splitting mid-sentence would invent errors at the seam.
    const long = 'x'.repeat(500);
    const chunks = planChunks([seg(long)], 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(long);
  });

  it('skips blank segments without spending payload on them', () => {
    const chunks = planChunks([seg('one'), seg('   '), seg('two')], 100);
    expect(chunks[0].text).toBe('one\n\ntwo');
    expect(chunks[0].entries.map((e) => e.index)).toEqual([0, 2]);
  });

  it('preserves the original indices across a split', () => {
    // The caller gets results back by index, so a split must not renumber.
    const chunks = planChunks(
      [seg('a'.repeat(60)), seg('b'.repeat(60)), seg('c')],
      100
    );
    expect(chunks.flatMap((c) => c.entries.map((e) => e.index))).toEqual([
      0, 1, 2
    ]);
  });

  it('returns nothing for an empty or all-blank document', () => {
    expect(planChunks([], 100)).toEqual([]);
    expect(planChunks([seg(''), seg('  ')], 100)).toEqual([]);
  });
});

describe('checkAll', () => {
  const seg = (text: string, from: number) => ({
    text,
    from,
    to: from + text.length
  });

  const batched = (
    onCheck: (text: string) => CheckerMatch[],
    config: (() => typeof CONFIG | null) | null = null
  ) => {
    const calls: string[] = [];
    const provider = createHttpCheckerProvider({
      id: 'lt',
      kinds: ['grammar', 'spelling'],
      categoryKinds: KINDS,
      config: config ?? (() => CONFIG),
      check: async ({ text }) => {
        calls.push(text);
        return onCheck(text);
      }
    });
    return { calls, provider };
  };

  const ctx = { languages: ['de'], signal: new AbortController().signal };

  it('sends many segments in one request', async () => {
    const { calls, provider: p } = batched(() => []);
    await p.checkAll!([seg('one', 0), seg('two', 10), seg('three', 20)], ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('one\n\ntwo\n\nthree');
  });

  it('returns each match against the segment it came from', async () => {
    // "two" starts at offset 5 in "one\n\ntwo"; the diagnostic must come
    // back at 0 relative to that segment, not 5.
    const { provider: p } = batched((text) => {
      const at = text.indexOf('two');
      return [match({ from: at, to: at + 3 })];
    });
    const out = await p.checkAll!([seg('one', 0), seg('two', 100)], ctx);
    expect(out[0]).toEqual([]);
    expect(out[1]).toEqual([
      expect.objectContaining({ from: 0, to: 3, source: 'lt' })
    ]);
  });

  it('does not leak a match across a paragraph boundary', async () => {
    // A match spanning the joiner belongs to neither segment.
    const { provider: p } = batched(() => [match({ from: 2, to: 7 })]);
    const out = await p.checkAll!([seg('one', 0), seg('two', 100)], ctx);
    expect(out).toEqual([[], []]);
  });

  it('declines every segment when unconfigured', async () => {
    const { calls, provider: p } = batched(
      () => [match()],
      () => null
    );
    expect(await p.checkAll!([seg('one', 0), seg('two', 10)], ctx)).toEqual([
      null,
      null
    ]);
    expect(calls).toHaveLength(0);
  });

  it('declines a blank segment rather than claiming it is clean', async () => {
    const { provider: p } = batched(() => []);
    const out = await p.checkAll!([seg('   ', 0), seg('real', 10)], ctx);
    expect(out[0]).toBeNull();
    expect(out[1]).toEqual([]);
  });
  it('reports a failed request and lets the error through', async () => {
    // Swallowing it would leave the last findings on screen while the server
    // is unreachable, with nothing anywhere saying so.
    const seen: { state: string; detail?: string }[] = [];
    const p = createHttpCheckerProvider({
      id: 'lt',
      kinds: ['grammar', 'spelling'],
      categoryKinds: KINDS,
      config: () => CONFIG,
      check: async () => {
        throw new Error('connection refused');
      },
      onStatus: (state, detail) => seen.push({ state, detail })
    });

    await expect(p.checkAll!([seg('one', 0)], ctx)).rejects.toThrow(
      'connection refused'
    );
    expect(seen).toEqual([{ state: 'failed', detail: 'connection refused' }]);
  });

  it('reports what a non-Error failure said', async () => {
    const seen: { state: string; detail?: string }[] = [];
    const p = createHttpCheckerProvider({
      id: 'lt',
      kinds: ['grammar'],
      categoryKinds: KINDS,
      config: () => CONFIG,
      check: async () => {
        throw 'checker returned 500';
      },
      onStatus: (state, detail) => seen.push({ state, detail })
    });

    await expect(p.checkAll!([seg('one', 0)], ctx)).rejects.toBeTruthy();
    expect(seen).toEqual([{ state: 'failed', detail: 'checker returned 500' }]);
  });

  it('drops a spelling finding on a word the user accepted', async () => {
    // A remote API has no per-request word list, so the personal dictionary
    // has to be applied to what comes back.
    const p = createHttpCheckerProvider({
      id: 'lt',
      kinds: ['grammar', 'spelling'],
      categoryKinds: KINDS,
      config: () => CONFIG,
      isIgnored: (word) => word === 'Mindstream',
      check: async () => [
        match({ from: 0, to: 10, category: 'TYPOS' }),
        match({ from: 11, to: 14, category: 'TYPOS' })
      ]
    });

    const out = await p.checkAll!([seg('Mindstream teh', 0)], ctx);
    expect(out[0]).toEqual([
      expect.objectContaining({ from: 11, to: 14, kind: 'spelling' })
    ]);
  });
});
