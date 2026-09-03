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
  /** Localized message for a misspelling, e.g. tUi('language.spellcheck.unknownWord'). */
  message(word: string): string;
  /**
   * Words the user has personally accepted. Applied here rather than in the
   * backend so that adding a word takes effect on the next check without a
   * dictionary reload.
   */
  isIgnored?(word: string): boolean;
  /**
   * `WORDCHARS` from the enabled dictionaries — the characters they declare
   * as part of a word. Read per check so enabling a language applies
   * immediately.
   */
  wordChars?(): string;
}

/**
 * The dictionary never declines — it is local, so it can always answer.
 *
 * Overriding `check` rather than intersecting it: an intersection would add
 * a second call signature that the looser one shadows, leaving callers with
 * a `null` they can never actually receive.
 */
export interface LocalSpellcheckProvider extends Omit<
  DiagnosticProvider,
  'check'
> {
  check(request: CheckRequest): Promise<Diagnostic[]>;
}

export function createSpellcheckProvider(
  options: SpellcheckProviderOptions
): LocalSpellcheckProvider {
  return {
    id: SPELLCHECK_PROVIDER_ID,
    kinds: ['spelling'],

    async check({
      text,
      languages,
      signal
    }: CheckRequest): Promise<Diagnostic[]> {
      if (languages.length === 0) return [];

      const tokens = tokenizeWords(text, 0, options.wordChars?.() ?? '');
      if (tokens.length === 0) return [];

      // A token is spelled correctly if EITHER form is accepted, so both
      // have to be offered wherever a verdict is reached — here for the
      // personal dictionary, and below for the engine.
      const accepted = (token: (typeof tokens)[number]) =>
        options.isIgnored?.(token.text) === true ||
        (token.abbreviation !== undefined &&
          options.isIgnored?.(token.abbreviation) === true);

      const candidates = options.isIgnored
        ? tokens.filter((token) => !accepted(token))
        : tokens;
      if (candidates.length === 0) return [];

      // One IPC round trip per segment, not per word — and a paragraph
      // repeats words heavily, so dedupe before crossing the boundary.
      // Every form that could settle a token, in one batch: the joined
      // token, its abbreviation, and its segments for the fallback.
      const distinct = [
        ...new Set(
          candidates.flatMap((token) => [
            token.text,
            ...(token.abbreviation ? [token.abbreviation] : []),
            ...(token.parts ?? []).map((part) => part.text)
          ])
        )
      ];
      const unknown = new Set(await options.unknownWords(languages, distinct));
      if (signal.aborted || unknown.size === 0) return [];

      // Map the verdict back onto every occurrence: the backend answered
      // about words, but a squiggle belongs to each position the word
      // appears at.
      //
      // `Nr.` is a dictionary entry while bare `Nr` is not, so requiring
      // BOTH forms to be unknown is what stops every German abbreviation
      // being flagged. The range still covers only the word, never the
      // period.
      const flag = (token: { text: string; from: number; to: number }) => ({
        from: token.from,
        to: token.to,
        kind: 'spelling' as const,
        message: options.message(token.text),
        replacements: [],
        source: SPELLCHECK_PROVIDER_ID
      });

      const knownAsWhole = (token: (typeof candidates)[number]) =>
        !unknown.has(token.text) ||
        (token.abbreviation !== undefined && !unknown.has(token.abbreviation));

      return candidates.flatMap((token) => {
        if (knownAsWhole(token)) return [];
        // Nothing known as a whole: judge the segments instead. This is what
        // keeps a unioned WORDCHARS safe — enabling Dutch declares `/` for
        // everyone, and `and/or` must not become one unknown word in English
        // text. It also gives a precise range per bad segment rather than one
        // squiggle over the lot.
        if (token.parts) {
          return token.parts.filter((part) => unknown.has(part.text)).map(flag);
        }
        return [flag(token)];
      });
    }
  };
}
