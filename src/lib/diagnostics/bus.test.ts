import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticBus, isAbortError, resolveOverlaps } from './bus';
import type {
  Diagnostic,
  DiagnosticKind,
  DiagnosticProvider,
  Segment
} from './types';

function diag(over: Partial<Diagnostic> = {}): Diagnostic {
  return {
    from: 0,
    to: 4,
    kind: 'spelling',
    message: 'x',
    replacements: [],
    source: 'test',
    ...over
  };
}

/** Flags every occurrence of `word`, reporting positions relative to the segment. */
function wordProvider(
  id: string,
  word: string,
  kind: DiagnosticKind = 'spelling'
): DiagnosticProvider & { calls: number } {
  const provider = {
    id,
    kinds: [kind] as const,
    calls: 0,
    check({ text }: { text: string }) {
      provider.calls += 1;
      const out: Diagnostic[] = [];
      let i = text.indexOf(word);
      while (i !== -1) {
        out.push(diag({ from: i, to: i + word.length, kind, source: id }));
        i = text.indexOf(word, i + 1);
      }
      return out;
    }
  };
  return provider;
}

const segments = (...parts: [string, number][]): Segment[] =>
  parts.map(([text, from]) => ({ text, from, to: from + text.length }));

describe('DiagnosticBus', () => {
  let bus: DiagnosticBus;

  beforeEach(() => {
    bus = new DiagnosticBus();
  });

  it('returns diagnostics from a registered provider', async () => {
    bus.register(wordProvider('spell', 'bad'));
    const out = await bus.check(segments(['a bad word', 0]), {
      languages: ['en']
    });
    expect(out).toEqual([
      diag({ from: 2, to: 5, source: 'spell', message: 'x' })
    ]);
  });

  it('returns nothing when no providers are registered', async () => {
    expect(
      await bus.check(segments(['a bad word', 0]), { languages: ['en'] })
    ).toEqual([]);
  });

  describe('offset rebasing', () => {
    // The single most consequential thing the bus does: providers see a
    // paragraph, the editor needs document positions. Getting this wrong
    // puts every squiggle after the first paragraph in the wrong place.
    it('rebases provider positions by the segment offset', async () => {
      bus.register(wordProvider('spell', 'bad'));
      const out = await bus.check(segments(['a bad word', 100]), {
        languages: ['en']
      });
      expect(out).toMatchObject([{ from: 102, to: 105 }]);
    });

    it('rebases each segment independently', async () => {
      bus.register(wordProvider('spell', 'bad'));
      const out = await bus.check(segments(['bad', 0], ['bad', 50]), {
        languages: ['en']
      });
      expect(out.map((d) => d.from)).toEqual([0, 50]);
    });
  });

  describe('caching', () => {
    it('does not re-check identical segment text', async () => {
      const provider = wordProvider('spell', 'bad');
      bus.register(provider);
      const opts = { languages: ['en'] };

      await bus.check(segments(['a bad word', 0]), opts);
      await bus.check(segments(['a bad word', 0]), opts);

      expect(provider.calls).toBe(1);
    });

    it('re-checks only the paragraph that changed', async () => {
      const provider = wordProvider('spell', 'bad');
      bus.register(provider);
      const opts = { languages: ['en'] };

      await bus.check(segments(['bad one', 0], ['bad two', 10]), opts);
      expect(provider.calls).toBe(2);

      await bus.check(segments(['bad one', 0], ['bad three', 10]), opts);
      expect(provider.calls).toBe(3);
    });

    it('re-checks when the language set changes', async () => {
      const provider = wordProvider('spell', 'bad');
      bus.register(provider);

      await bus.check(segments(['bad', 0]), { languages: ['en'] });
      await bus.check(segments(['bad', 0]), { languages: ['en', 'de'] });

      expect(provider.calls).toBe(2);
    });

    it('treats language order as irrelevant', async () => {
      const provider = wordProvider('spell', 'bad');
      bus.register(provider);

      await bus.check(segments(['bad', 0]), { languages: ['en', 'de'] });
      await bus.check(segments(['bad', 0]), { languages: ['de', 'en'] });

      expect(provider.calls).toBe(1);
    });

    it('re-checks after the cache is cleared', async () => {
      const provider = wordProvider('spell', 'bad');
      bus.register(provider);
      const opts = { languages: ['en'] };

      await bus.check(segments(['bad', 0]), opts);
      bus.clearCache();
      await bus.check(segments(['bad', 0]), opts);

      expect(provider.calls).toBe(2);
    });

    it('evicts the least recently used entry past the limit', async () => {
      const small = new DiagnosticBus(2);
      const provider = wordProvider('spell', 'bad');
      small.register(provider);
      const opts = { languages: ['en'] };

      await small.check(segments(['bad a', 0]), opts);
      await small.check(segments(['bad b', 0]), opts);
      // Touch 'bad a' so 'bad b' becomes the eviction victim.
      await small.check(segments(['bad a', 0]), opts);
      await small.check(segments(['bad c', 0]), opts);
      expect(provider.calls).toBe(3);

      await small.check(segments(['bad a', 0]), opts);
      expect(provider.calls).toBe(3); // still cached

      await small.check(segments(['bad b', 0]), opts);
      expect(provider.calls).toBe(4); // was evicted
    });

    it('drops a provider’s cached results when it unregisters', async () => {
      const provider = wordProvider('spell', 'bad');
      const off = bus.register(provider);
      const opts = { languages: ['en'] };

      await bus.check(segments(['bad', 0]), opts);
      off();
      bus.register(provider);
      await bus.check(segments(['bad', 0]), opts);

      expect(provider.calls).toBe(2);
    });
  });

  describe('provider isolation', () => {
    it('keeps other providers’ results when one throws', async () => {
      const failing: DiagnosticProvider = {
        id: 'broken',
        kinds: ['grammar'],
        check() {
          throw new Error('boom');
        }
      };
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      bus.register(failing);
      bus.register(wordProvider('spell', 'bad'));

      const out = await bus.check(segments(['a bad word', 0]), {
        languages: ['en']
      });

      expect(out).toHaveLength(1);
      expect(out[0].source).toBe('spell');
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('retries a failed provider rather than caching the failure', async () => {
      let attempts = 0;
      const flaky: DiagnosticProvider = {
        id: 'flaky',
        kinds: ['spelling'],
        check() {
          attempts += 1;
          if (attempts === 1) throw new Error('transient');
          return [diag({ source: 'flaky' })];
        }
      };
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      bus.register(flaky);
      const opts = { languages: ['en'] };

      expect(await bus.check(segments(['word', 0]), opts)).toEqual([]);
      expect(await bus.check(segments(['word', 0]), opts)).toHaveLength(1);
      spy.mockRestore();
    });

    it('refuses to register the same id twice', () => {
      bus.register(wordProvider('spell', 'bad'));
      expect(() => bus.register(wordProvider('spell', 'other'))).toThrow(
        /already registered/
      );
    });
  });

  describe('cancellation', () => {
    it('throws an abort error when the signal is already aborted', async () => {
      bus.register(wordProvider('spell', 'bad'));
      const ac = new AbortController();
      ac.abort();

      await expect(
        bus.check(segments(['bad', 0]), {
          languages: ['en'],
          signal: ac.signal
        })
      ).rejects.toSatisfy(isAbortError);
    });

    it('stops before running remaining segments once aborted mid-flight', async () => {
      const ac = new AbortController();
      const provider: DiagnosticProvider & { calls: number } = {
        id: 'slow',
        kinds: ['spelling'],
        calls: 0,
        check() {
          provider.calls += 1;
          ac.abort();
          return [];
        }
      };
      bus.register(provider);

      await expect(
        bus.check(segments(['a', 0], ['b', 10], ['c', 20]), {
          languages: ['en'],
          signal: ac.signal
        })
      ).rejects.toSatisfy(isAbortError);
      expect(provider.calls).toBe(1);
    });
  });
});

describe('resolveOverlaps', () => {
  it('keeps the higher-precedence provider when the same kind overlaps', () => {
    const out = resolveOverlaps(
      [
        diag({ from: 0, to: 4, source: 'low' }),
        diag({ from: 2, to: 6, source: 'high' })
      ],
      ['high', 'low']
    );
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('high');
  });

  it('keeps both when the kinds differ', () => {
    // A grammar hint over a phrase containing a typo is two true statements.
    const out = resolveOverlaps(
      [
        diag({ from: 0, to: 4, kind: 'spelling', source: 'spell' }),
        diag({ from: 0, to: 10, kind: 'grammar', source: 'lt' })
      ],
      ['lt', 'spell']
    );
    expect(out).toHaveLength(2);
  });

  it('keeps non-overlapping diagnostics from the same provider', () => {
    const out = resolveOverlaps(
      [diag({ from: 0, to: 4 }), diag({ from: 5, to: 9 })],
      ['test']
    );
    expect(out).toHaveLength(2);
  });

  it('treats a shared boundary as non-overlapping', () => {
    const out = resolveOverlaps(
      [
        diag({ from: 0, to: 4, source: 'a' }),
        diag({ from: 4, to: 8, source: 'b' })
      ],
      ['a', 'b']
    );
    expect(out).toHaveLength(2);
  });

  it('ranks unlisted providers after listed ones', () => {
    const out = resolveOverlaps(
      [
        diag({ from: 0, to: 4, source: 'unknown' }),
        diag({ from: 1, to: 5, source: 'listed' })
      ],
      ['listed']
    );
    expect(out[0].source).toBe('listed');
  });

  it('returns results in document order regardless of precedence', () => {
    const out = resolveOverlaps(
      [
        diag({ from: 20, to: 24, source: 'high' }),
        diag({ from: 0, to: 4, source: 'low' })
      ],
      ['high', 'low']
    );
    expect(out.map((d) => d.from)).toEqual([0, 20]);
  });
});

/**
 * Kind ownership. Precedence alone only resolves OVERLAPPING findings, so
 * two providers reporting spelling would still produce a union — every word
 * the owner happened not to flag would survive from the other, leaving the
 * user with two rankings at once.
 */
describe('kind ownership', () => {
  const owners = { spelling: 'lt' } as const;

  /** Fails for segments whose text contains `failOn`. */
  const flaky = (
    id: string,
    word: string,
    failOn?: string
  ): DiagnosticProvider => ({
    id,
    kinds: ['spelling'],
    check({ text }) {
      if (failOn !== undefined && text.includes(failOn)) {
        throw new Error('server down');
      }
      const at = text.indexOf(word);
      return at === -1
        ? []
        : [diag({ from: at, to: at + word.length, source: id })];
    }
  });

  it('drops the non-owner when the owner answered', async () => {
    const bus = new DiagnosticBus();
    bus.register(flaky('lt', 'alpha'));
    bus.register(flaky('spell', 'beta'));

    const out = await bus.check(segments(['alpha beta', 0]), {
      languages: ['en'],
      owners
    });
    // "beta" is only known to the dictionary, but the owner answered for
    // this segment, so its silence is the verdict.
    expect(out.map((d) => d.source)).toEqual(['lt']);
  });

  it('keeps the non-owner when the owner failed', async () => {
    // The offline fallback: an unreachable server must not leave the
    // document quietly clean.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = new DiagnosticBus();
    bus.register(flaky('lt', 'alpha', 'beta'));
    bus.register(flaky('spell', 'beta'));

    const out = await bus.check(segments(['alpha beta', 0]), {
      languages: ['en'],
      owners
    });
    expect(out.map((d) => d.source)).toEqual(['spell']);
    spy.mockRestore();
  });

  it('resolves ownership per segment, not per document', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = new DiagnosticBus();
    bus.register(flaky('lt', 'beta', 'boom'));
    bus.register(flaky('spell', 'beta'));

    const out = await bus.check(
      segments(['beta here', 0], ['beta boom', 100]),
      { languages: ['en'], owners }
    );
    // First segment: owner answered, so only its finding survives. Second:
    // owner threw, so the fallback covers that paragraph alone.
    expect(out.map((d) => `${d.source}@${d.from}`)).toEqual([
      'lt@0',
      'spell@100'
    ]);
    spy.mockRestore();
  });

  it('leaves other kinds untouched', async () => {
    const bus = new DiagnosticBus();
    bus.register(flaky('lt', 'alpha'));
    bus.register({
      id: 'grammar',
      kinds: ['grammar'],
      check: () => [
        diag({ from: 6, to: 10, kind: 'grammar', source: 'grammar' })
      ]
    });

    const out = await bus.check(segments(['alpha beta', 0]), {
      languages: ['en'],
      owners
    });
    expect(out.map((d) => d.source).sort()).toEqual(['grammar', 'lt']);
  });

  it('behaves as before when no owner is declared', async () => {
    const bus = new DiagnosticBus();
    bus.register(flaky('lt', 'alpha'));
    bus.register(flaky('spell', 'beta'));

    const out = await bus.check(segments(['alpha beta', 0]), {
      languages: ['en']
    });
    expect(out).toHaveLength(2);
  });
});

/**
 * The reported regression: enabling LanguageTool made spellchecking display
 * nothing at all.
 *
 * An unconfigured checker returned `[]`, which the bus read as "I checked,
 * nothing is wrong" — and since it owned spelling, that verdict suppressed
 * the local dictionary for every paragraph. Declining has to be distinct
 * from finding nothing.
 */
describe('a provider that declines', () => {
  const owners = { spelling: 'lt' } as const;

  const declining: DiagnosticProvider = {
    id: 'lt',
    kinds: ['spelling'],
    // Not configured yet, so it has no opinion at all.
    check: () => null
  };

  const dictionary: DiagnosticProvider = {
    id: 'spell',
    kinds: ['spelling'],
    check: ({ text }) => {
      const at = text.indexOf('teh');
      return at === -1 ? [] : [diag({ from: at, to: at + 3, source: 'spell' })];
    }
  };

  it('does not suppress the fallback', async () => {
    const bus = new DiagnosticBus();
    bus.register(declining);
    bus.register(dictionary);

    const out = await bus.check(segments(['teh cat', 0]), {
      languages: ['en'],
      owners
    });
    expect(out.map((d) => d.source)).toEqual(['spell']);
  });

  it('contributes nothing of its own', async () => {
    const bus = new DiagnosticBus();
    bus.register(declining);

    expect(
      await bus.check(segments(['teh cat', 0]), { languages: ['en'], owners })
    ).toEqual([]);
  });

  it('is not cached, so it can answer once configured', async () => {
    // Caching "no opinion" would keep a checker silent after the user
    // finally fills in the server URL.
    let configured = false;
    const provider: DiagnosticProvider = {
      id: 'lt',
      kinds: ['spelling'],
      check: () => (configured ? [diag({ source: 'lt' })] : null)
    };
    const bus = new DiagnosticBus();
    bus.register(provider);
    const opts = { languages: ['en'], owners };

    expect(await bus.check(segments(['teh cat', 0]), opts)).toEqual([]);
    configured = true;
    expect(await bus.check(segments(['teh cat', 0]), opts)).toHaveLength(1);
  });

  it('still suppresses the fallback once it answers', async () => {
    const bus = new DiagnosticBus();
    bus.register({
      id: 'lt',
      kinds: ['spelling'],
      check: () => []
    });
    bus.register(dictionary);

    const out = await bus.check(segments(['teh cat', 0]), {
      languages: ['en'],
      owners
    });
    expect(out).toEqual([]);
  });
});
