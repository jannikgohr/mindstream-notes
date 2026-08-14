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
 * Everything not listed is treated as grammar. `TYPOS` is deliberately
 * absent: the built-in dictionary owns spelling, and the plugin disables
 * that category server-side anyway — this is the second line of defence, so
 * a misconfigured server cannot produce a second, disagreeing squiggle on a
 * word we already checked.
 */
const STYLE_CATEGORIES = new Set([
  'STYLE',
  'REDUNDANCY',
  'PLAIN_ENGLISH',
  'WORDINESS',
  'CREATIVE_WRITING'
]);

export function categoryToKind(category: string): DiagnosticKind | null {
  if (category === 'TYPOS') return null;
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
  } | null;
  check(args: {
    endpoint: string;
    apiKey?: string;
    username?: string;
    language: string;
    text: string;
    disabledCategories: string[];
  }): Promise<LanguageToolMatch[]>;
}

export function createLanguageToolProvider(
  options: LanguageToolProviderOptions
): DiagnosticProvider {
  return {
    id: options.id,
    kinds: options.kinds,

    async check({ text, signal }: CheckRequest): Promise<Diagnostic[]> {
      const config = options.config();
      if (!config) return [];
      // Whitespace-only segments still cost a network round trip, which is
      // the expensive resource here — unlike the dictionary path, where a
      // wasted check is microseconds.
      if (text.trim().length === 0) return [];

      const matches = await options.check({ ...config, text });
      if (signal.aborted) return [];

      return matches.flatMap((match) => {
        const kind = categoryToKind(match.category);
        if (kind === null) return [];
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
