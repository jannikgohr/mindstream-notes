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
import { spellcheckUnknownWords } from '$lib/api/spellcheck';
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
 * Drop every memoized verdict.
 *
 * Called when the installed dictionaries change: the cache is keyed by the
 * selected languages, not by what is on disk, so installing German would
 * otherwise leave every previously-checked paragraph showing the verdicts it
 * got when German was missing.
 */
export function invalidateDiagnostics(): void {
  bus.clearCache();
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
