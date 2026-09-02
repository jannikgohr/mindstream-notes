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

/**
 * Progressive results. Checkers differ in speed by orders of magnitude — the
 * local dictionary answers in microseconds, a LanguageTool round trip takes
 * seconds. Waiting for all of them meant a freshly opened note showed
 * nothing at all until the network answered.
 */
describe('partial results', () => {
  /** Resolves only when released, so ordering is explicit. */
  function slow(id: string, word: string) {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider: DiagnosticProvider = {
      id,
      kinds: ['grammar'],
      async check({ text }) {
        await gate;
        const at = text.indexOf(word);
        return at === -1
          ? []
          : [
              diag({
                from: at,
                to: at + word.length,
                kind: 'grammar',
                source: id
              })
            ];
      }
    };
    return { provider, release: () => release?.() };
  }

  const fast = (id: string, word: string): DiagnosticProvider => ({
    id,
    kinds: ['spelling'],
    check: ({ text }) => {
      const at = text.indexOf(word);
      return at === -1
        ? []
        : [diag({ from: at, to: at + word.length, source: id })];
    }
  });

  it('reports the fast checker before the slow one finishes', async () => {
    const bus = new DiagnosticBus();
    const slowOne = slow('lt', 'beta');
    bus.register(slowOne.provider);
    bus.register(fast('spell', 'alpha'));

    const partials: string[][] = [];
    const done = bus.check(segments(['alpha beta', 0]), {
      languages: ['en'],
      onPartial: (d) => partials.push(d.map((x) => x.source))
    });

    // Let the fast provider settle while the slow one is still pending.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(partials).toEqual([['spell']]);

    slowOne.release();
    await done;
    expect(partials[partials.length - 1].sort()).toEqual(['lt', 'spell']);
  });

  it('does not wait for a slow provider before starting a fast one', async () => {
    // Sequential providers meant the dictionary's answer was held hostage
    // by a network request that had not even been sent yet.
    const bus = new DiagnosticBus();
    const slowOne = slow('lt', 'beta');
    bus.register(slowOne.provider);

    let fastRan = false;
    bus.register({
      id: 'spell',
      kinds: ['spelling'],
      check: () => {
        fastRan = true;
        return [];
      }
    });

    const done = bus.check(segments(['alpha beta', 0]), { languages: ['en'] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fastRan).toBe(true);

    slowOne.release();
    await done;
  });

  it('applies ownership to the final result, not just the partials', async () => {
    const bus = new DiagnosticBus();
    const owner = slow('lt', 'alpha');
    bus.register({ ...owner.provider, kinds: ['spelling'] });
    bus.register(fast('spell', 'alpha'));

    const partials: string[][] = [];
    const done = bus.check(segments(['alpha beta', 0]), {
      languages: ['en'],
      owners: { spelling: 'lt' },
      onPartial: (d) => partials.push(d.map((x) => x.source))
    });

    // The dictionary has finished by now, but the owner is still working on
    // this segment, so its spelling is held back rather than drawn and
    // immediately replaced.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(partials[0]).toEqual([]);

    owner.release();
    expect((await done).map((d) => d.source)).toEqual(['lt']);
  });
});

/**
 * Waiting for the owner, and the bound on that wait.
 *
 * The reported symptom: typing in a note checked by LanguageTool made the
 * local dictionary's squiggles flash up for about a second on every
 * keystroke and then be replaced. The dictionary answers in microseconds
 * and the service in seconds, and in between "the owner has not answered"
 * looked the same as "the owner has no opinion".
 */
describe('owner grace', () => {
  const slowOwner = (id: string, word: string) => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider: DiagnosticProvider = {
      id,
      kinds: ['spelling'],
      async check({ text }) {
        await gate;
        const at = text.indexOf(word);
        return at === -1
          ? []
          : [diag({ from: at, to: at + word.length, source: id })];
      }
    };
    return { provider, release: () => release?.() };
  };

  const dictionary: DiagnosticProvider = {
    id: 'spell',
    kinds: ['spelling'],
    check: ({ text }) => {
      const at = text.indexOf('teh');
      return at === -1 ? [] : [diag({ from: at, to: at + 3, source: 'spell' })];
    }
  };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('draws the fallback once the grace expires', async () => {
    // A service that hangs rather than failing must not take spellchecking
    // down with it.
    const bus = new DiagnosticBus();
    const owner = slowOwner('lt', 'teh');
    bus.register(owner.provider);
    bus.register(dictionary);

    const partials: string[][] = [];
    const done = bus.check(segments(['teh cat', 0]), {
      languages: ['en'],
      owners: { spelling: 'lt' },
      ownerGraceMs: 5,
      onPartial: (d) => partials.push(d.map((x) => x.source))
    });

    await settle();
    expect(partials).toEqual([[]]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(partials.at(-1)).toEqual(['spell']);

    // And the owner's answer still replaces it when it finally lands.
    owner.release();
    expect((await done).map((d) => d.source)).toEqual(['lt']);
  });

  it('does not wait for an owner that is not registered', async () => {
    // Nobody is checking that kind, so there is nothing to wait for.
    const bus = new DiagnosticBus();
    bus.register(dictionary);

    const partials: string[][] = [];
    await bus.check(segments(['teh cat', 0]), {
      languages: ['en'],
      owners: { spelling: 'lt' },
      onPartial: (d) => partials.push(d.map((x) => x.source))
    });
    expect(partials[0]).toEqual(['spell']);
  });

  it('does not wait once the owner has failed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = new DiagnosticBus();
    bus.register({
      id: 'lt',
      kinds: ['spelling'],
      check: () => {
        throw new Error('server down');
      }
    });
    bus.register(dictionary);

    const out = await bus.check(segments(['teh cat', 0]), {
      languages: ['en'],
      owners: { spelling: 'lt' },
      // Long enough that passing this test can only mean the failure ended
      // the wait, not that the grace ran out.
      ownerGraceMs: 60_000
    });
    expect(out.map((d) => d.source)).toEqual(['spell']);
    spy.mockRestore();
  });

  it('holds back only the kind that is owned', async () => {
    const bus = new DiagnosticBus();
    const owner = slowOwner('lt', 'teh');
    bus.register(owner.provider);
    bus.register(dictionary);
    bus.register({
      id: 'style',
      kinds: ['grammar'],
      check: () => [diag({ from: 0, to: 3, kind: 'grammar', source: 'style' })]
    });

    const partials: string[][] = [];
    const done = bus.check(segments(['teh cat', 0]), {
      languages: ['en'],
      owners: { spelling: 'lt' },
      onPartial: (d) => partials.push(d.map((x) => x.source))
    });
    await settle();
    expect(partials.at(-1)).toEqual(['style']);
    owner.release();
    await done;
  });

  it('keeps the checks it already has while it re-checks one paragraph', async () => {
    // Typing changes one paragraph. Every other paragraph's answer is
    // already cached, and it goes out before the request for the edited one
    // is even sent — otherwise the whole note's squiggles disappear for as
    // long as the round trip takes.
    const bus = new DiagnosticBus();
    let gate: (() => void) | undefined;
    let calls = 0;
    bus.register({
      id: 'lt',
      kinds: ['spelling'],
      async checkAll(parts) {
        calls += 1;
        if (calls > 1) {
          await new Promise<void>((resolve) => {
            gate = resolve;
          });
        }
        return parts.map((part) => {
          const at = part.text.indexOf('teh');
          return at === -1
            ? []
            : [diag({ from: at, to: at + 3, source: 'lt' })];
        });
      },
      check: () => null
    });

    const first = segments(['teh cat', 0], ['teh dog', 100]);
    await bus.check(first, { languages: ['en'], owners: { spelling: 'lt' } });

    // Edit the second paragraph; the first is unchanged.
    const partials: Diagnostic[][] = [];
    const done = bus.check(segments(['teh cat', 0], ['teh dogs', 100]), {
      languages: ['en'],
      owners: { spelling: 'lt' },
      onPartial: (d) => partials.push(d)
    });
    await settle();
    expect(partials.at(-1)?.map((d) => d.from)).toEqual([0]);

    gate?.();
    expect((await done).map((d) => d.from)).toEqual([0, 100]);
  });

  it('stops the grace timer when the check is over', async () => {
    // A timer that outlived its check would publish a composition of a
    // document the editor has already moved on from.
    const bus = new DiagnosticBus();
    bus.register(dictionary);
    bus.register({
      id: 'lt',
      kinds: ['spelling'],
      check: () => null
    });

    const partials: string[][] = [];
    await bus.check(segments(['teh cat', 0]), {
      languages: ['en'],
      owners: { spelling: 'lt' },
      ownerGraceMs: 5,
      onPartial: (d) => partials.push(d.map((x) => x.source))
    });
    const seen = partials.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(partials.length).toBe(seen);
  });
});

/**
 * The bulk path. For a network checker this is the difference between a
 * usable feature and an unusable one: a request costs about the same whatever
 * it carries, so a 30-paragraph note checked one paragraph at a time takes
 * minutes and batched takes seconds.
 */
describe('DiagnosticBus — bulk providers', () => {
  /** Flags each segment whole, and records how many calls it took. */
  function batchProvider(id = 'batch'): DiagnosticProvider & { calls: number } {
    const provider = {
      id,
      kinds: ['grammar'] as const,
      calls: 0,
      check: () => null,
      async checkAll(parts: Segment[]) {
        provider.calls += 1;
        return parts.map((part) =>
          part.text.includes('bad')
            ? [
                diag({
                  from: 0,
                  to: part.text.length,
                  kind: 'grammar',
                  source: id
                })
              ]
            : null
        );
      }
    };
    return provider;
  }

  it('checks every segment in one call', async () => {
    const bus = new DiagnosticBus();
    const provider = batchProvider();
    bus.register(provider);

    const out = await bus.check(
      segments(['a bad line', 0], ['fine', 20], ['also bad', 40]),
      { languages: ['en'] }
    );

    expect(provider.calls).toBe(1);
    expect(out.map((d) => [d.from, d.to])).toEqual([
      [0, 10],
      [40, 48]
    ]);
  });

  it('caches per segment, so only the edited one is re-checked', async () => {
    const bus = new DiagnosticBus();
    const provider = batchProvider();
    bus.register(provider);

    await bus.check(segments(['a bad line', 0], ['fine', 20]), {
      languages: ['en']
    });
    await bus.check(segments(['a bad line', 0], ['fine too', 20]), {
      languages: ['en']
    });

    expect(provider.calls).toBe(2);
  });

  it('exposes the registered providers', async () => {
    const bus = new DiagnosticBus();
    const provider = batchProvider();
    const off = bus.register(provider);
    expect(bus.providers.map((p) => p.id)).toEqual(['batch']);
    off();
    expect(bus.providers).toEqual([]);
  });
});
