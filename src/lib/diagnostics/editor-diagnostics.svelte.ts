/**
 * The app's live diagnostics pipeline, wired to settings.
 *
 * A single bus shared by every editor surface and every open note, rather
 * than one per editor. The bus caches by (provider, languages, paragraph
 * text), so sharing it means switching notes — or looking at the same note
 * in Split view, where the WYSIWYG and Source panes check identical text —
 * costs one check rather than two.
 *
 * This is the only module in `$lib/diagnostics` that touches app state; the
 * rest stays free of runes so it can be unit-tested against plain objects.
 */

import { DiagnosticBus } from './bus';
import {
  createSpellcheckProvider,
  SPELLCHECK_PROVIDER_ID
} from './spellcheck-provider';
import type { Diagnostic, DiagnosticProvider, Segment } from './types';
import {
  spellcheckAvailableDictionaries,
  spellcheckSuggest,
  spellcheckUnknownWords,
  spellcheckWordChars
} from '$lib/api/spellcheck';
import { rankSuggestions } from './suggestion-rank';
import { isCustomWord } from './custom-dictionary.svelte';
import {
  invalidateDiagnostics,
  subscribeDiagnosticsInvalidated
} from './invalidate';
import { getSettingValue } from '$lib/settings/store.svelte';
import { tUi } from '$lib/settings/i18n.svelte';

const bus = new DiagnosticBus();

bus.register(
  createSpellcheckProvider({
    unknownWords: spellcheckUnknownWords,
    message: () => tUi('editor.spellcheck.unknownWord'),
    // Filtered in the frontend, before the word is ever sent for
    // checking, so accepting a word takes effect on the next check with
    // no dictionary reload.
    isIgnored: isCustomWord,
    // Cached rather than fetched per check: it changes only when the
    // language selection or installed set does, both of which already
    // raise an invalidation.
    wordChars: () => wordChars
  })
);

/**
 * Precedence when two providers report the same kind over the same text.
 *
 * The built-in dictionary owns spelling. A grammar service can also report
 * spelling, and showing two squiggles with two different suggestion lists on
 * one word is worse than either alone — so the dictionary is listed first
 * and plugin checkers rank after it.
 */
const PRECEDENCE = [SPELLCHECK_PROVIDER_ID];

/**
 * The characters the enabled dictionaries declare as part of a word.
 *
 * Empty until loaded, which degrades to letters-only tokenization — the
 * behaviour before WORDCHARS was honoured, so a slow or failed load costs
 * accuracy on abbreviations rather than breaking checking outright.
 */
let wordChars = '';

/**
 * Dictionary id -> BCP-47 tag, e.g. `de_DE_frami` -> `de-DE`.
 *
 * Read from the backend catalogue rather than duplicated here: the mapping
 * already exists there, and a second copy would drift the moment a
 * dictionary is added.
 */
let bcp47ById = new Map<string, string>();

/** BCP-47 tags for the languages the user selected, for a network checker. */
export function selectedLanguageTags(): string[] {
  return spellcheckLanguages()
    .map((id) => bcp47ById.get(id))
    .filter((tag): tag is string => tag !== undefined);
}

async function refreshLanguageTags(): Promise<void> {
  const available = await spellcheckAvailableDictionaries();
  bcp47ById = new Map(available.map((entry) => [entry.id, entry.bcp47]));
}

async function refreshWordChars(): Promise<void> {
  const languages = spellcheckLanguages();
  wordChars =
    languages.length === 0 ? '' : await spellcheckWordChars(languages);
}

// The cache is keyed by the selected languages, so installing a dictionary
// or accepting a word does not change the key even though it changes the
// answer. Clearing it is just another thing to do on invalidation.
subscribeDiagnosticsInvalidated(() => {
  bus.clearCache();
  void refreshWordChars();
  void refreshLanguageTags();
});

export { invalidateDiagnostics, subscribeDiagnosticsInvalidated };

/**
 * Add a provider to the shared bus, returning its unregister function.
 *
 * The seam plugin-contributed checkers come in through. Registering also
 * invalidates: a new checker has an opinion about text already on screen,
 * and nothing in any open document has changed to trigger a redraw.
 */
export function registerProvider(provider: DiagnosticProvider): () => void {
  const off = bus.register(provider);
  invalidateDiagnostics();
  return () => {
    off();
    invalidateDiagnostics();
  };
}

export function spellcheckEnabled(): boolean {
  return (
    (getSettingValue('editor.spellcheck.enabled') as boolean | undefined) ??
    true
  );
}

export function spellcheckLanguages(): string[] {
  const value = getSettingValue('editor.spellcheck.languages');
  return Array.isArray(value) ? (value as string[]) : [];
}

/**
 * Check a document's segments. Handed to the editor plugins, which own
 * debouncing, cancellation and rendering.
 *
 * Returns nothing when the feature is off or no language is selected, so the
 * surfaces do not need to know why there is nothing to draw.
 */
export async function checkSegments(
  segments: Segment[],
  signal: AbortSignal,
  /** Draw what is known so far, so a fast checker is not held up by a slow one. */
  onPartial?: (diagnostics: Diagnostic[]) => void
): Promise<Diagnostic[]> {
  if (!spellcheckEnabled()) return [];
  const languages = spellcheckLanguages();
  if (languages.length === 0) return [];

  const current = spellingOwner();
  return bus.check(segments, {
    languages,
    precedence: current ? [current.id, ...PRECEDENCE] : PRECEDENCE,
    // Ownership, not just precedence: two providers reporting spelling
    // would otherwise union into two rankings over the same paragraph.
    owners: current ? { spelling: current.id } : undefined,
    onPartial,
    signal
  });
}

/**
 * Which provider owns spelling, if not the built-in dictionary.
 *
 * Set by `plugin-checkers`, which knows what the enabled plugins claim.
 * Kept here because the bus call is here, and so the rest of the app has
 * one place to ask "who is checking spelling right now?".
 */
let owner = $state<{ id: string; label: string } | null>(null);

export function setSpellingOwner(providerId: string | null, label = ''): void {
  owner = providerId ? { id: providerId, label } : null;
}

/**
 * Who is checking spelling, for the settings UI.
 *
 * Reactive and public because "my spellchecking stopped" is exactly the
 * question a handover makes hard to answer: the dictionary panel looks
 * unchanged while something else has quietly taken the job over.
 */
export function spellingOwner(): { id: string; label: string } | null {
  return owner;
}

/**
 * Corrections for one word, best first.
 *
 * spellbook emits in generation order, which is not relevance order, so the
 * result is re-ranked here — see `suggestion-rank.ts`. Deliberately applied
 * to the dictionary path only: a provider that ships its own `replacements`
 * has already ranked them by information we do not have.
 */
export async function suggestFor(word: string): Promise<string[]> {
  const languages = spellcheckLanguages();
  if (languages.length === 0) return [];
  return rankSuggestions(word, await spellcheckSuggest(languages, word));
}
