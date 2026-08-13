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
import type { Diagnostic, Segment } from './types';
import { spellcheckSuggest, spellcheckUnknownWords } from '$lib/api/spellcheck';
import { rankSuggestions } from './suggestion-rank';
import { getSettingValue } from '$lib/settings/store.svelte';
import { tUi } from '$lib/settings/i18n.svelte';

const bus = new DiagnosticBus();

bus.register(
  createSpellcheckProvider({
    unknownWords: spellcheckUnknownWords,
    message: () => tUi('editor.spellcheck.unknownWord')
  })
);

/**
 * Precedence when two providers report the same kind over the same text.
 *
 * The built-in dictionary owns spelling. When the LanguageTool plugin
 * arrives it will also be able to report spelling, and showing two squiggles
 * with two different suggestion lists on one word is worse than either
 * alone.
 */
const PRECEDENCE = [SPELLCHECK_PROVIDER_ID];

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
 * Editors that want telling when their results go stale.
 *
 * A plugin can see its own document change and re-check itself. It cannot
 * see the language selection change or a dictionary finish installing, and
 * both silently change the answer for text that has not been touched.
 */
const listeners = new Set<() => void>();

export function subscribeDiagnosticsInvalidated(
  recheck: () => void
): () => void {
  listeners.add(recheck);
  return () => listeners.delete(recheck);
}

/**
 * Drop every memoized verdict and ask every open editor to re-check.
 *
 * Two distinct staleness problems, one call:
 *
 *   - the CACHE is keyed by the selected languages, so installing a
 *     dictionary does not change the key even though it changes the answer;
 *   - the DRAWN squiggles were computed under the previous configuration and
 *     nothing in the document has changed to trigger a redraw.
 *
 * Missing the second is what left German words underlined after German was
 * enabled, each suggesting its own spelling back — the squiggle was stale
 * while the suggestion lookup was live.
 */
export function invalidateDiagnostics(): void {
  bus.clearCache();
  for (const listener of listeners) listener();
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
  signal: AbortSignal
): Promise<Diagnostic[]> {
  if (!spellcheckEnabled()) return [];
  const languages = spellcheckLanguages();
  if (languages.length === 0) return [];

  return bus.check(segments, { languages, precedence: PRECEDENCE, signal });
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
