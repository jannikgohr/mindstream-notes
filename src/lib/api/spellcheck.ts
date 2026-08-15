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
  assertNumber,
  assertRecord,
  assertString,
  assertStringArray,
  invokeOrFallback,
  TauriCommandName
} from './core';
import type { PluginCheckerProtocol } from '$lib/plugins/types';

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

/**
 * The `WORDCHARS` union for the given languages — the characters those
 * dictionaries declare as part of a word.
 */
export function spellcheckWordChars(languages: string[]): Promise<string> {
  return invokeOrFallback<string>(
    TauriCommandName.SpellcheckWordChars,
    { languages },
    () => '',
    (value) => assertString(value, 'spellcheck_word_chars response')
  );
}

export interface CheckerMatch {
  from: number;
  to: number;
  message: string;
  replacements: string[];
  category: string;
}

/**
 * Grammar and style check against whatever service a plugin declared.
 *
 * The only spellchecking call that leaves the machine — the dictionary path
 * never touches the network. Host-executed rather than plugin-executed: the
 * text of every note being edited passes through here, so a plugin describes
 * the wire format but never receives the text or chooses the destination.
 */
export function textCheckerCheck(args: {
  endpoint: string;
  apiKey?: string;
  username?: string;
  language: string;
  text: string;
  disabledCategories: string[];
  preferredVariants?: string[];
  protocol: PluginCheckerProtocol;
}): Promise<CheckerMatch[]> {
  return invokeOrFallback<CheckerMatch[]>(
    TauriCommandName.TextCheckerCheck,
    {
      endpoint: args.endpoint,
      apiKey: args.apiKey ?? null,
      username: args.username ?? null,
      language: args.language,
      text: args.text,
      disabledCategories: args.disabledCategories,
      preferredVariants: args.preferredVariants ?? [],
      protocol: args.protocol
    },
    () => [],
    (value) => {
      if (!Array.isArray(value)) {
        throw new Error('text_checker_check response must be an array');
      }
      return value.map((item, index) => {
        const record = assertRecord(item, `match[${index}]`);
        return {
          from: assertNumber(record.from, `match[${index}].from`),
          to: assertNumber(record.to, `match[${index}].to`),
          message: assertString(record.message, `match[${index}].message`),
          replacements: assertStringArray(
            record.replacements,
            `match[${index}].replacements`
          ),
          category: assertString(record.category, `match[${index}].category`)
        };
      });
    }
  );
}

export interface TestConnectionResult {
  ok: boolean;
  /** Server-provided detail; not translated — it reports what the server said. */
  detail: string;
  /** Selected languages this server does not offer. */
  missingLanguages: string[];
}

/**
 * Verify a checking service is reachable, and that credentials work when
 * supplied. Sends a fixed probe string, never note content.
 */
export function textCheckerTestConnection(args: {
  endpoint: string;
  apiKey?: string;
  username?: string;
  /** BCP-47 tags the user writes in, so the server can be checked for them. */
  wantedLanguages?: string[];
  protocol: PluginCheckerProtocol;
}): Promise<TestConnectionResult> {
  return invokeOrFallback<TestConnectionResult>(
    TauriCommandName.TextCheckerTestConnection,
    {
      endpoint: args.endpoint,
      apiKey: args.apiKey ?? null,
      username: args.username ?? null,
      wantedLanguages: args.wantedLanguages ?? [],
      protocol: args.protocol
    },
    () => ({
      ok: false,
      detail: 'unavailable outside the desktop app',
      missingLanguages: []
    }),
    (value) => {
      const record = assertRecord(
        value,
        'text_checker_test_connection response'
      );
      return {
        ok: assertBoolean(record.ok, 'testConnection.ok'),
        detail: assertString(record.detail, 'testConnection.detail'),
        missingLanguages: assertStringArray(
          record.missingLanguages,
          'testConnection.missingLanguages'
        )
      };
    }
  );
}

/** The user's personal dictionary, in the casing they typed. */
export function customDictionaryList(): Promise<string[]> {
  return invokeOrFallback<string[]>(
    TauriCommandName.CustomDictionaryList,
    undefined,
    () => [],
    (value) => assertStringArray(value, 'custom_dictionary_list response')
  );
}

export function customDictionaryAdd(word: string): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.CustomDictionaryAdd,
    { word },
    () => undefined,
    () => undefined
  );
}

export function customDictionaryRemove(word: string): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.CustomDictionaryRemove,
    { word },
    () => undefined,
    () => undefined
  );
}
