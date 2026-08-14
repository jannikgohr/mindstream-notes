/**
 * A plugin-contributed LanguageTool checker, as a diagnostics provider.
 *
 * The plugin supplies configuration; the host makes the request and renders
 * the result. Nothing here executes plugin code — a checker sees the full
 * text of every note being edited, so the request stays in one auditable
 * place rather than becoming something a plugin can redirect.
 */

import type {
  CheckRequest,
  Diagnostic,
  DiagnosticKind,
  DiagnosticProvider
} from './types';

/**
 * LanguageTool category ids mapped to diagnostic kinds.
 *
 * Everything not listed is treated as grammar.
 *
 * `TYPOS` maps to spelling, which the server only sends when the user has
 * asked LanguageTool to check spelling too. Its rankings beat ours: it
 * scores candidates with sentence context, where the dictionary can only
 * compare strings. Which of the two is actually shown is settled by kind
 * ownership in the bus, not here.
 */
const STYLE_CATEGORIES = new Set([
  'STYLE',
  'REDUNDANCY',
  'PLAIN_ENGLISH',
  'WORDINESS',
  'CREATIVE_WRITING'
]);

export function categoryToKind(category: string): DiagnosticKind {
  if (category === 'TYPOS') return 'spelling';
  return STYLE_CATEGORIES.has(category) ? 'style' : 'grammar';
}

export interface LanguageToolMatch {
  from: number;
  to: number;
  message: string;
  replacements: string[];
  category: string;
}

export interface LanguageToolProviderOptions {
  /** Provider id, already namespaced to the owning plugin. */
  id: string;
  kinds: readonly DiagnosticKind[];
  /**
   * Resolved per check rather than captured, so editing the endpoint or key
   * in settings takes effect without reloading the plugin.
   *
   * Returning null disables the provider — an unset endpoint means the user
   * has not configured it yet, which must read as "no opinion" rather than
   * an error on every paragraph.
   */
  config(): {
    endpoint: string;
    apiKey?: string;
    username?: string;
    language: string;
    disabledCategories: string[];
    preferredVariants: string[];
  } | null;
  /**
   * Words the user has personally accepted.
   *
   * Applied to LanguageTool's SPELLING findings here, client-side, because
   * the check API has no per-request custom word list. Without it, every
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
  check(args: {
    endpoint: string;
    apiKey?: string;
    username?: string;
    language: string;
    text: string;
    disabledCategories: string[];
    preferredVariants: string[];
  }): Promise<LanguageToolMatch[]>;
}

export function createLanguageToolProvider(
  options: LanguageToolProviderOptions
): DiagnosticProvider {
  return {
    id: options.id,
    kinds: options.kinds,

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

      let matches: LanguageToolMatch[];
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
        const kind = categoryToKind(match.category);
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
            // finding: LanguageTool ranks them by rule confidence, which we
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
