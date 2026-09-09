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
import type { Token } from './tokenize';
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

      const ignored = (form: string | undefined) =>
        form !== undefined && options.isIgnored?.(form) === true;

      // A token is spelled correctly if EITHER form is accepted, so both
      // have to be offered wherever a verdict is reached — here for the
      // personal dictionary, and below for the engine.
      const accepted = (token: Token) =>
        ignored(token.text) || ignored(token.abbreviation);

      const candidates = options.isIgnored
        ? tokens.filter((token) => !accepted(token))
        : tokens;
      if (candidates.length === 0) return [];

      // Every form that could settle a token: the joined token, its
      // abbreviation, and its segments (plus theirs) for the fallback.
      // Forms the user already accepted are left out — the answer is
      // settled, and the personal dictionary is deliberately not something
      // the backend knows about.
      const forms = (token: Token) =>
        [token.text, token.abbreviation].filter(
          (form): form is string => form !== undefined && !ignored(form)
        );

      // One IPC round trip per segment, not per word — and a paragraph
      // repeats words heavily, so dedupe before crossing the boundary.
      const distinct = [
        ...new Set(
          candidates.flatMap((token) => [
            ...forms(token),
            ...(token.parts ?? []).flatMap(forms)
          ])
        )
      ];
      if (distinct.length === 0) return [];

      const unknown = new Set(await options.unknownWords(languages, distinct));
      if (signal.aborted) return [];

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

      // One predicate for both authorities, applied at every level either
      // one is asked at. Consulting the personal dictionary only for whole
      // tokens is what used to make an accepted `MindstreamNotes` fail: the
      // fallback judged `Mindstream` against the engine alone.
      const known = (form: string | undefined) =>
        form !== undefined && (ignored(form) || !unknown.has(form));
      const spelled = (token: Token) =>
        known(token.text) || known(token.abbreviation);

      return candidates.flatMap((token) => {
        if (spelled(token)) return [];
        // Nothing accepted as a whole: judge the segments instead. This is
        // what keeps a unioned WORDCHARS safe — enabling Dutch declares `/`
        // for everyone, and `and/or` must not become one unknown word in
        // English text — and what lets a camelCase identifier pass on the
        // strength of its parts. It also gives a precise range per bad
        // segment rather than one squiggle over the lot.
        if (token.parts) {
          return token.parts.filter((part) => !spelled(part)).map(flag);
        }
        return [flag(token)];
      });
    }
  };
}
