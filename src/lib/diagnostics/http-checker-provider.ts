/**
 * A plugin-contributed checking service, as a diagnostics provider.
 *
 * The plugin declares configuration and a wire format; the host makes the
 * request and renders the result. Nothing here executes plugin code — a
 * checker sees the full text of every note being edited, so the request stays
 * in one auditable place rather than becoming something a plugin can redirect.
 *
 * Everything in this file is service-agnostic. It used to name LanguageTool's
 * rule categories — including German-only ones — which meant a second service
 * could not be added without editing the app. Categories now arrive from the
 * manifest, because they are the service's vocabulary and not the host's.
 */

import type { PluginCheckerProtocol } from '$lib/plugins/types';
import type {
  CheckRequest,
  Diagnostic,
  DiagnosticKind,
  DiagnosticProvider
} from './types';

/**
 * A service's rule categories mapped to diagnostic kinds.
 *
 * Supplied by the plugin. Anything unlisted falls back to `defaultKind`,
 * which keeps a manifest short: a service typically has one spelling category
 * and a handful of style ones, and everything else is grammar.
 */
export interface CategoryKinds {
  map: Readonly<Record<string, DiagnosticKind>>;
  fallback: DiagnosticKind;
}

export function categoryToKind(
  category: string,
  kinds: CategoryKinds
): DiagnosticKind {
  return kinds.map[category] ?? kinds.fallback;
}

/**
 * How much text goes into one request.
 *
 * Measured against a real server: a request costs ~2.4s almost regardless
 * of size (2,000 chars took 2.7s, 10,000 took 5.9s), so the cost is
 * dominated by the round trip, not the payload. Batching is therefore
 * enormously cheaper than per-paragraph checking — but one huge request
 * also means waiting for the whole note before anything appears. A few
 * medium chunks in parallel gets both.
 */
const MAX_CHUNK_CHARS = 4000;

/**
 * How many chunks are in flight at once.
 *
 * Self-hosted instances are not rate-limited the way the public API is, so
 * concurrency is the lever that turns "seconds per chunk" into "seconds for
 * the document". Capped rather than unbounded so a very long note does not
 * open fifty sockets at once.
 */
const MAX_PARALLEL_CHUNKS = 4;

/**
 * Paragraph separator inside a batched request.
 *
 * A blank line, so the server sees paragraph boundaries where the document
 * has them — sentence-spanning rules must not fire across two unrelated
 * paragraphs that only happen to be adjacent in the payload.
 */
const JOINER = '\n\n';

interface ChunkEntry {
  /** Index into the caller's segment list. */
  index: number;
  /** Offset of this segment's text within the joined chunk. */
  at: number;
  length: number;
}

/** Group segments into request-sized chunks, remembering where each landed. */
export function planChunks(
  segments: { text: string }[],
  maxChars = MAX_CHUNK_CHARS
): { text: string; entries: ChunkEntry[] }[] {
  const chunks: { text: string; entries: ChunkEntry[] }[] = [];
  let text = '';
  let entries: ChunkEntry[] = [];

  const flush = () => {
    if (entries.length > 0) chunks.push({ text, entries });
    text = '';
    entries = [];
  };

  for (const [index, segment] of segments.entries()) {
    // Blank segments are not worth a byte of payload, and would only add
    // separator noise between real paragraphs.
    if (segment.text.trim().length === 0) continue;

    const prefix = text.length === 0 ? '' : JOINER;
    // A single oversized paragraph still goes on its own rather than being
    // split mid-sentence, which would invent errors at the seam.
    if (
      text.length > 0 &&
      text.length + prefix.length + segment.text.length > maxChars
    ) {
      flush();
    }
    const at = text.length === 0 ? 0 : text.length + JOINER.length;
    text = text.length === 0 ? segment.text : text + JOINER + segment.text;
    entries.push({ index, at, length: segment.text.length });
  }
  flush();

  return chunks;
}

/** Run `task` over `items`, at most `limit` at a time. */
async function inParallel<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await task(items[i]);
      }
    }
  );
  await Promise.all(workers);
  return out;
}

/**
 * Everything one request needs, resolved per check.
 *
 * `protocol` rides along rather than being captured once because the manifest
 * is reloaded when a plugin updates, and a stale wire format would fail in the
 * least obvious way possible — a working server answering nothing.
 */
export interface CheckerConfig {
  endpoint: string;
  apiKey?: string;
  username?: string;
  language: string;
  disabledCategories: string[];
  preferredVariants: string[];
  protocol: PluginCheckerProtocol;
}

export interface CheckerMatch {
  from: number;
  to: number;
  message: string;
  replacements: string[];
  category: string;
}

export interface HttpCheckerProviderOptions {
  /** Provider id, already namespaced to the owning plugin. */
  id: string;
  kinds: readonly DiagnosticKind[];
  /** The service's categories, as the plugin declared them. */
  categoryKinds: CategoryKinds;
  /**
   * Resolved per check rather than captured, so editing the endpoint or key
   * in settings takes effect without reloading the plugin.
   *
   * Returning null disables the provider — an unset endpoint means the user
   * has not configured it yet, which must read as "no opinion" rather than
   * an error on every paragraph.
   */
  config(): CheckerConfig | null;
  /**
   * Words the user has personally accepted.
   *
   * Applied to the service's SPELLING findings here, client-side, because a
   * remote check API has no per-request custom word list. Without it, every
   * word added to the personal dictionary would come back underlined and
   * "Add to dictionary" would silently do nothing.
   */
  isIgnored?(word: string): boolean;
  /**
   * Reports what actually happened, so the settings UI can show a live
   * state instead of the user pressing a button to find out. Called on
   * every run — the store ignores repeats.
   */
  onStatus?(state: 'unconfigured' | 'active' | 'failed', detail?: string): void;
  check(args: CheckerConfig & { text: string }): Promise<CheckerMatch[]>;
}

export function createHttpCheckerProvider(
  options: HttpCheckerProviderOptions
): DiagnosticProvider {
  const toDiagnostics = (
    matches: CheckerMatch[],
    text: string,
    offset: number
  ): Diagnostic[] =>
    matches.flatMap((match) => {
      const kind = categoryToKind(match.category, options.categoryKinds);
      // The server reports a range, not a word, so recover the word from
      // the text we submitted to consult the personal dictionary.
      if (
        kind === 'spelling' &&
        options.isIgnored?.(text.slice(match.from, match.to)) === true
      ) {
        return [];
      }
      return [
        {
          from: match.from - offset,
          to: match.to - offset,
          kind,
          message: match.message,
          replacements: match.replacements,
          source: options.id
        }
      ];
    });

  return {
    id: options.id,
    kinds: options.kinds,

    /**
     * Batched path — the one that actually runs in the editor.
     *
     * Per-paragraph checking made a long note take minutes: a request costs
     * about the same whether it carries one paragraph or twenty, so the
     * round trips dominated. Chunks also give the server more context,
     * which makes language detection confident enough to stop second-
     * guessing it.
     */
    async checkAll(segments, { signal }): Promise<(Diagnostic[] | null)[]> {
      const config = options.config();
      const results: (Diagnostic[] | null)[] = segments.map(() => null);
      if (!config) {
        options.onStatus?.('unconfigured');
        return results;
      }

      const chunks = planChunks(segments);
      if (chunks.length === 0) return results;

      let failure: unknown = null;
      await inParallel(chunks, MAX_PARALLEL_CHUNKS, async (chunk) => {
        if (signal.aborted || failure) return;
        try {
          const matches = await options.check({ ...config, text: chunk.text });
          if (signal.aborted) return;
          for (const entry of chunk.entries) {
            // Matches are chunk-relative; split them back per segment and
            // rebase, so the bus still sees segment-relative positions.
            const inSegment = matches.filter(
              (m) => m.from >= entry.at && m.to <= entry.at + entry.length
            );
            results[entry.index] = toDiagnostics(
              inSegment,
              chunk.text,
              entry.at
            );
          }
        } catch (err) {
          failure = err;
        }
      });

      if (failure) {
        options.onStatus?.(
          'failed',
          failure instanceof Error ? failure.message : String(failure)
        );
        throw failure;
      }
      if (signal.aborted) return segments.map(() => null);
      options.onStatus?.('active');
      return results;
    },

    async check({ text, signal }: CheckRequest): Promise<Diagnostic[] | null> {
      const config = options.config();
      // No server configured yet: no opinion. Returning an empty array here
      // would read as "nothing is misspelled" and, once this provider owns
      // spelling, would suppress the local dictionary — so merely enabling
      // the plugin would turn spellchecking off.
      if (!config) {
        options.onStatus?.('unconfigured');
        return null;
      }
      // Whitespace-only segments still cost a network round trip, which is
      // the expensive resource here — unlike the dictionary path, where a
      // wasted check is microseconds.
      if (text.trim().length === 0) return null;

      let matches: CheckerMatch[];
      try {
        matches = await options.check({ ...config, text });
      } catch (err) {
        // Reported before rethrowing: the bus turns this into "provider
        // skipped for this segment", which is invisible on its own.
        options.onStatus?.(
          'failed',
          err instanceof Error ? err.message : String(err)
        );
        throw err;
      }
      if (signal.aborted) return null;
      options.onStatus?.('active');

      return matches.flatMap((match) => {
        const kind = categoryToKind(match.category, options.categoryKinds);
        // The server reports a range, not a word, so recover the word from
        // the text we submitted to consult the personal dictionary.
        if (
          kind === 'spelling' &&
          options.isIgnored?.(text.slice(match.from, match.to)) === true
        ) {
          return [];
        }
        return [
          {
            from: match.from,
            to: match.to,
            kind,
            message: match.message,
            // Unlike the dictionary path, replacements arrive with the
            // finding: the service ranks them by rule confidence, which we
            // could not reconstruct, so they are used as-is and never
            // re-sorted.
            replacements: match.replacements,
            source: options.id
          }
        ];
      });
    }
  };
}
