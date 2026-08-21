/**
 * The diagnostics bus: fans a document out to every registered checker and
 * folds the results back into one ordered list.
 *
 * Providers know nothing about each other, about the editor surfaces, or
 * about how their findings are drawn. They receive a paragraph and return
 * ranges. Everything that must be consistent across checkers — offset
 * arithmetic, caching, precedence when two of them flag the same span,
 * surviving a checker that throws — lives here, once.
 *
 * Deliberately free of Svelte runes and app state so it can be exercised
 * against plain objects, matching the convention the editor plugins follow.
 * Reactivity belongs to the surfaces that consume it.
 */

import type {
  Diagnostic,
  DiagnosticKind,
  DiagnosticProvider,
  Segment
} from './types';

export interface CheckOptions {
  languages: string[];
  /**
   * Provider ids, most authoritative first. When two providers report the
   * same KIND over overlapping text, the earlier id wins and the other is
   * dropped.
   *
   * The case this exists for: LanguageTool and the built-in dictionary both
   * report spelling. Rather than showing the user two squiggles with two
   * different suggestion lists, one provider is declared to own the kind.
   * Unlisted providers rank after listed ones, in registration order.
   */
  precedence?: readonly string[];
  /**
   * Which provider OWNS a kind, when one should replace the others rather
   * than merely outrank them.
   *
   * Precedence alone is not enough. It resolves overlapping findings, so two
   * providers reporting spelling would still produce a union — every finding
   * the owner happened not to make would survive from the other one, and the
   * user would face two rankings at once.
   *
   * Ownership is resolved PER SEGMENT and only when the owner actually
   * answered for that segment. That is the fallback: if LanguageTool is
   * unreachable, the built-in dictionary's findings stand and spellchecking
   * keeps working offline, rather than the document going quietly clean.
   */
  owners?: Partial<Record<DiagnosticKind, string>>;
  /**
   * How long a fallback waits for the owner of a kind before drawing anyway.
   *
   * Ownership is a question about a finished check, but findings are drawn
   * as they arrive. The local dictionary answers a paragraph in microseconds
   * and a service takes seconds, so between the two the owner has not
   * answered yet — which used to read as "the owner has no opinion" and put
   * the dictionary's squiggles on screen under the user's cursor, to be
   * replaced by the service's a second later. Every keystroke did it again.
   *
   * While the owner is still working on a segment its fallbacks stay quiet.
   * The grace bounds that: a service that hangs rather than failing must not
   * take spellchecking down with it, so once it expires the fallbacks are
   * drawn and the owner's answer, if it ever comes, replaces them.
   */
  ownerGraceMs?: number;
  /**
   * Called each time a provider finishes, with everything known so far.
   *
   * Checkers differ in speed by orders of magnitude — the local dictionary
   * is microseconds, a LanguageTool round trip is seconds. Without this the
   * fast one's findings wait on the slow one, and a freshly opened note
   * shows nothing at all until the network answers.
   */
  onPartial?(diagnostics: Diagnostic[]): void;
  signal?: AbortSignal;
}

/**
 * How many (provider, languages, paragraph-text) results to remember.
 *
 * Sized for "a long document plus a few providers" rather than for
 * unbounded history: the win is that editing one paragraph re-checks one
 * paragraph, so the rest of the document must survive in cache across a
 * keystroke. Beyond that, holding results for text the user has already
 * left is not worth the memory.
 */
const DEFAULT_CACHE_ENTRIES = 512;

/**
 * Cache-key field separator. A unit separator cannot occur in a language
 * tag or a provider id, so no tuple can forge a collision with a different
 * one by embedding the separator in a field.
 */
const KEY_SEP = String.fromCharCode(31);

/**
 * Default `ownerGraceMs`.
 *
 * A LanguageTool round trip measured ~2.4s, dominated by the trip rather
 * than the payload, so the grace has to clear that comfortably or it would
 * re-introduce the flicker it exists to prevent on every slow-ish response.
 * It is a backstop for a service that never answers at all, not a latency
 * budget.
 */
const DEFAULT_OWNER_GRACE_MS = 6000;

class AbortError extends Error {
  readonly name = 'AbortError';
  constructor() {
    super('Diagnostics check aborted');
  }
}

/** True for the error `check()` throws when its signal is aborted. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export class DiagnosticBus {
  #providers: DiagnosticProvider[] = [];
  #cache = new Map<string, Diagnostic[]>();
  #cacheLimit: number;

  constructor(cacheLimit = DEFAULT_CACHE_ENTRIES) {
    this.#cacheLimit = cacheLimit;
  }

  /** Returns an unregister function, so callers can tear down symmetrically. */
  register(provider: DiagnosticProvider): () => void {
    if (this.#providers.some((p) => p.id === provider.id)) {
      throw new Error(`Diagnostic provider already registered: ${provider.id}`);
    }
    this.#providers.push(provider);
    return () => {
      this.#providers = this.#providers.filter((p) => p !== provider);
      // A provider's cached findings are meaningless once it is gone, and a
      // plugin re-registering after an update must not inherit stale ones.
      this.#invalidateProvider(provider.id);
    };
  }

  get providers(): readonly DiagnosticProvider[] {
    return this.#providers;
  }

  /** Drop all memoized results — call when a dictionary or rule set changes. */
  clearCache(): void {
    this.#cache.clear();
  }

  async check(
    segments: Segment[],
    options: CheckOptions
  ): Promise<Diagnostic[]> {
    const { languages, signal } = options;
    const owners = options.owners ?? {};
    const found: {
      providerId: string;
      segment: number;
      diagnostic: Diagnostic;
    }[] = [];
    /** Provider ids per segment index that returned without failing. */
    const answered = new Map<number, Set<string>>();

    /**
     * Owners this run is still waiting on.
     *
     * Only owners that are actually registered: a kind owned by a provider
     * that is not here is not being checked by anyone, so nothing should
     * wait for it.
     */
    const registered = new Set(this.#providers.map((p) => p.id));
    const waitingFor = new Set(
      Object.values(owners).filter(
        (id): id is string => id !== undefined && registered.has(id)
      )
    );
    /** True once the grace expired, or when there was nothing to wait for. */
    let graceExpired = waitingFor.size === 0;

    /** Everything known so far, with ownership applied. */
    const compose = (): Diagnostic[] => {
      const owned = found
        .filter(({ providerId, segment, diagnostic }) => {
          const owner = owners[diagnostic.kind];
          if (owner === undefined || owner === providerId) return true;
          // The owner spoke for THIS segment, so its silence is the verdict.
          if (answered.get(segment)?.has(owner)) return false;
          // Still working on it: stay quiet rather than flashing a second
          // opinion that is about to be overwritten.
          return graceExpired || !waitingFor.has(owner);
        })
        .map(({ diagnostic }) => diagnostic);
      return resolveOverlaps(owned, this.#order(options.precedence));
    };

    // Nothing redraws by itself when the grace expires — the owner is, by
    // definition, not finishing — so the wait ends with a publish of its own.
    const grace = options.ownerGraceMs ?? DEFAULT_OWNER_GRACE_MS;
    const graceTimer =
      graceExpired || grace <= 0
        ? null
        : setTimeout(() => {
            graceExpired = true;
            if (!signal?.aborted) options.onPartial?.(compose());
          }, grace);

    /**
     * Take one provider's answer for one segment into the running result.
     *
     * Providers report positions relative to the text they were handed;
     * rebasing happens here so no provider has to know where in the document
     * its paragraph lives. Recording also marks the provider as having
     * answered for that segment, which is what ownership is resolved on.
     */
    const record = (
      provider: DiagnosticProvider,
      index: number,
      relative: Diagnostic[]
    ) => {
      const seen = answered.get(index) ?? new Set<string>();
      seen.add(provider.id);
      answered.set(index, seen);

      const segment = segments[index];
      for (const d of relative) {
        found.push({
          providerId: provider.id,
          segment: index,
          diagnostic: {
            ...d,
            from: d.from + segment.from,
            to: d.to + segment.from
          }
        });
      }
    };

    const runProvider = async (provider: DiagnosticProvider) => {
      // Split cached from pending first, so the bulk path is only asked
      // about segments that actually need work — editing one paragraph of a
      // long note should cost one paragraph, not the whole document again.
      const resolved = new Map<number, Diagnostic[]>();
      const pending: { index: number; segment: Segment; key: string }[] = [];

      for (const [index, segment] of segments.entries()) {
        const key = this.#key(provider.id, languages, segment.text);
        const hit = this.#cacheGet(key);
        if (hit === undefined) pending.push({ index, segment, key });
        else resolved.set(index, hit);
      }

      // What is already known goes out before the slow part starts. A
      // keystroke leaves every other paragraph's text untouched, so a
      // network checker has a cached answer for all of them — holding those
      // back until the one edited paragraph comes back from the server took
      // the whole document's squiggles off screen on every keystroke, which
      // is the other half of the flicker.
      if (resolved.size > 0 && pending.length > 0) {
        for (const [index, relative] of resolved)
          record(provider, index, relative);
        resolved.clear();
        options.onPartial?.(compose());
      }

      if (pending.length > 0) {
        const request = {
          languages,
          signal: signal ?? new AbortController().signal
        };
        try {
          if (provider.checkAll) {
            const batch = await provider.checkAll(
              pending.map((p) => p.segment),
              request
            );
            pending.forEach((p, i) => {
              const answer = batch[i] ?? null;
              if (answer === null) return;
              this.#cacheSet(p.key, answer);
              resolved.set(p.index, answer);
            });
          } else {
            for (const p of pending) {
              if (signal?.aborted) throw new AbortError();
              const answer = await provider.check({
                ...request,
                text: p.segment.text
              });
              if (answer === null) continue;
              this.#cacheSet(p.key, answer);
              resolved.set(p.index, answer);
            }
          }
        } catch (err) {
          if (isAbortError(err)) throw err;
          // One broken checker must not blank out every squiggle in the
          // document — especially once third-party plugins can register.
          // Nothing is cached, so a transient fault is retried next pass.
          console.error(`Diagnostic provider "${provider.id}" failed`, err);
        }
      }

      for (const [index, relative] of resolved)
        record(provider, index, relative);

      // Nobody is waiting on this one any more — whether it answered,
      // declined or failed, its fallbacks are free to draw from here on.
      waitingFor.delete(provider.id);

      // Publish as soon as THIS provider is done. The local dictionary
      // answers in microseconds while a network checker takes seconds, so
      // holding its findings back until the slow one lands is why a note
      // showed nothing at all for seconds after opening.
      options.onPartial?.(compose());
    };

    try {
      // Run in parallel: a slow network checker must not delay a local one
      // that was ready immediately.
      await Promise.all(this.#providers.map(runProvider));
    } finally {
      if (graceTimer !== null) clearTimeout(graceTimer);
    }

    if (signal?.aborted) throw new AbortError();
    return compose();
  }

  /** Provider ids in precedence order: explicit list first, then registration order. */
  #order(precedence: readonly string[] | undefined): string[] {
    const registered = this.#providers.map((p) => p.id);
    if (!precedence) return registered;
    return [
      ...precedence,
      ...registered.filter((id) => !precedence.includes(id))
    ];
  }

  #key(providerId: string, languages: string[], text: string): string {
    return [providerId, [...languages].sort().join(','), text].join(KEY_SEP);
  }

  #cacheGet(key: string): Diagnostic[] | undefined {
    const hit = this.#cache.get(key);
    if (hit === undefined) return undefined;
    // Refresh recency — Map preserves insertion order, so re-inserting
    // moves the entry to the back and makes the first key the LRU victim.
    this.#cache.delete(key);
    this.#cache.set(key, hit);
    return hit;
  }

  #cacheSet(key: string, value: Diagnostic[]): void {
    this.#cache.set(key, value);
    while (this.#cache.size > this.#cacheLimit) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }

  #invalidateProvider(providerId: string): void {
    const prefix = providerId + KEY_SEP;
    for (const key of this.#cache.keys()) {
      if (key.startsWith(prefix)) this.#cache.delete(key);
    }
  }
}

/**
 * Drop lower-precedence diagnostics that overlap a higher-precedence one of
 * the same kind, and return what survives in document order.
 *
 * Only same-kind conflicts are resolved. A grammar hint spanning a phrase
 * that also contains a misspelled word is not a conflict — those are two
 * true statements about the text and the user benefits from both.
 */
export function resolveOverlaps(
  diagnostics: Diagnostic[],
  precedence: readonly string[]
): Diagnostic[] {
  const rank = (source: string) => {
    const i = precedence.indexOf(source);
    return i === -1 ? precedence.length : i;
  };

  const ordered = [...diagnostics].sort(
    (a, b) => rank(a.source) - rank(b.source) || a.from - b.from || a.to - b.to
  );

  const kept: Diagnostic[] = [];
  const byKind = new Map<DiagnosticKind, Diagnostic[]>();

  for (const d of ordered) {
    const sameKind = byKind.get(d.kind) ?? [];
    const conflicts = sameKind.some((k) => d.from < k.to && k.from < d.to);
    if (conflicts) continue;
    sameKind.push(d);
    byKind.set(d.kind, sameKind);
    kept.push(d);
  }

  return kept.sort((a, b) => a.from - b.from || a.to - b.to);
}
