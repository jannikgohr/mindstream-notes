/**
 * The built-in dictionary checker, as a diagnostics provider.
 *
 * Tokenizes a segment, asks the backend which of those words no enabled
 * dictionary recognises, and turns the answer back into ranges.
 *
 * `replacements` is deliberately left empty here. Suggestions cost tens of
 * milliseconds per word against spellbook — three to four orders of
 * magnitude more than a check — so fetching them for every misspelling in a
 * document would make typing stutter for menus the user will never open.
 * The popover fetches them for the one word it is about to show.
 */

import type { CheckRequest, Diagnostic, DiagnosticProvider } from './types';
import { tokenizeWords } from './tokenize';

export const SPELLCHECK_PROVIDER_ID = 'spellcheck';

export interface SpellcheckProviderOptions {
  /**
   * Injected rather than imported so this module stays testable without a
   * Tauri runtime, and so the custom dictionary can wrap it later.
   */
  unknownWords(languages: string[], words: string[]): Promise<string[]>;
  /** Localized message for a misspelling, e.g. tUi('editor.spellcheck.unknownWord'). */
  message(word: string): string;
  /**
   * Words the user has personally accepted. Applied here rather than in the
   * backend so that adding a word takes effect on the next check without a
   * dictionary reload.
   */
  isIgnored?(word: string): boolean;
}

export function createSpellcheckProvider(
  options: SpellcheckProviderOptions
): DiagnosticProvider {
  return {
    id: SPELLCHECK_PROVIDER_ID,
    kinds: ['spelling'],

    async check({
      text,
      languages,
      signal
    }: CheckRequest): Promise<Diagnostic[]> {
      if (languages.length === 0) return [];

      const tokens = tokenizeWords(text);
      if (tokens.length === 0) return [];

      const candidates = options.isIgnored
        ? tokens.filter((token) => !options.isIgnored?.(token.text))
        : tokens;
      if (candidates.length === 0) return [];

      // One IPC round trip per segment, not per word — and a paragraph
      // repeats words heavily, so dedupe before crossing the boundary.
      const distinct = [...new Set(candidates.map((token) => token.text))];
      const unknown = new Set(await options.unknownWords(languages, distinct));
      if (signal.aborted || unknown.size === 0) return [];

      // Map the verdict back onto every occurrence: the backend answered
      // about words, but a squiggle belongs to each position the word
      // appears at.
      return candidates
        .filter((token) => unknown.has(token.text))
        .map((token) => ({
          from: token.from,
          to: token.to,
          kind: 'spelling' as const,
          message: options.message(token.text),
          replacements: [],
          source: SPELLCHECK_PROVIDER_ID
        }));
    }
  };
}
