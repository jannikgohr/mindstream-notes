/**
 * Spellcheck bridge — JS side.
 *
 * The dictionaries live in Rust (see `src-tauri/src/spellcheck`), so only
 * words and verdicts cross this boundary, never dictionary bytes.
 *
 * Checking and suggesting are separate calls on purpose: checking a word is
 * microseconds, suggesting for one is tens of milliseconds and grows
 * superlinearly with word length. The editor checks continuously; it asks
 * for suggestions only when the user opens the popover on a specific word.
 *
 * In the browser-dev build there is no backend, so every call falls back to
 * "no opinion" — no squiggles rather than fake ones.
 */

import {
  assertBoolean,
  assertRecord,
  assertString,
  assertStringArray,
  invokeOrFallback,
  TauriCommandName
} from './core';

export interface InstalledDictionary {
  id: string;
  bytes: number;
}

export interface AvailableDictionary {
  id: string;
  bcp47: string;
  /** SPDX-ish licence as stated upstream; empty when the source states none. */
  license: string;
  /** Upstream folder, so the user can read the licence before installing. */
  sourceUrl: string;
  installed: boolean;
}

/** The subset of `words` that no enabled dictionary recognises. */
export function spellcheckUnknownWords(
  languages: string[],
  words: string[]
): Promise<string[]> {
  return invokeOrFallback<string[]>(
    TauriCommandName.SpellcheckUnknownWords,
    { languages, words },
    // Without a backend, nothing is unknown — an empty result means no
    // squiggles, which is the right failure mode.
    () => [],
    (value) => assertStringArray(value, 'spellcheck_unknown_words response')
  );
}

/** Corrections for one word, best first. Only called on user request. */
export function spellcheckSuggest(
  languages: string[],
  word: string
): Promise<string[]> {
  return invokeOrFallback<string[]>(
    TauriCommandName.SpellcheckSuggest,
    { languages, word },
    () => [],
    (value) => assertStringArray(value, 'spellcheck_suggest response')
  );
}

export function spellcheckAvailableDictionaries(): Promise<
  AvailableDictionary[]
> {
  return invokeOrFallback<AvailableDictionary[]>(
    TauriCommandName.SpellcheckAvailableDictionaries,
    undefined,
    () => [],
    (value) => {
      if (!Array.isArray(value)) {
        throw new Error(
          'spellcheck_available_dictionaries response must be an array'
        );
      }
      return value.map((item, index) => {
        const record = assertRecord(item, `dictionary[${index}]`);
        return {
          id: assertString(record.id, `dictionary[${index}].id`),
          bcp47: assertString(record.bcp47, `dictionary[${index}].bcp47`),
          license: assertString(record.license, `dictionary[${index}].license`),
          sourceUrl: assertString(
            record.sourceUrl,
            `dictionary[${index}].sourceUrl`
          ),
          installed: assertBoolean(
            record.installed,
            `dictionary[${index}].installed`
          )
        };
      });
    }
  );
}

export function spellcheckInstallDictionary(id: string): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.SpellcheckInstallDictionary,
    { id },
    () => undefined,
    () => undefined
  );
}

export function spellcheckRemoveDictionary(id: string): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.SpellcheckRemoveDictionary,
    { id },
    () => undefined,
    () => undefined
  );
}
