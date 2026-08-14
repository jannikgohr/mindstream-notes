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
    const results: {
      providerId: string;
      segment: number;
      diagnostic: Diagnostic;
    }[] = [];
    /** Provider ids per segment index that returned without failing. */
    const answered = new Map<number, Set<string>>();

    for (const provider of this.#providers) {
      if (signal?.aborted) throw new AbortError();

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
              const found = batch[i] ?? null;
              if (found === null) return;
              this.#cacheSet(p.key, found);
              resolved.set(p.index, found);
            });
          } else {
            for (const p of pending) {
              if (signal?.aborted) throw new AbortError();
              const found = await provider.check({
                ...request,
                text: p.segment.text
              });
              if (found === null) continue;
              this.#cacheSet(p.key, found);
              resolved.set(p.index, found);
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

      for (const [index, relative] of resolved) {
        const seen = answered.get(index) ?? new Set<string>();
        seen.add(provider.id);
        answered.set(index, seen);

        // Providers report positions relative to the text they were handed;
        // rebasing happens here so no provider has to know where in the
        // document its paragraph lives.
        const segment = segments[index];
        for (const d of relative) {
          results.push({
            providerId: provider.id,
            segment: index,
            diagnostic: {
              ...d,
              from: d.from + segment.from,
              to: d.to + segment.from
            }
          });
        }
      }
    }

    if (signal?.aborted) throw new AbortError();

    const owned = results
      .filter(({ providerId, segment, diagnostic }) => {
        const owner = owners[diagnostic.kind];
        if (owner === undefined || owner === providerId) return true;
        // Drop only when the owner actually answered for THIS segment.
        return !answered.get(segment)?.has(owner);
      })
      .map(({ diagnostic }) => diagnostic);

    return resolveOverlaps(owned, this.#order(options.precedence));
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
