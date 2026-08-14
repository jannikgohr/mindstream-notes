/**
 * The user's personal dictionary, mirrored in memory.
 *
 * Held as an in-memory set rather than queried per word for one reason:
 * the spellcheck provider consults it for EVERY token in a paragraph on
 * every check, and a round trip per word would cost far more than the
 * checking does. The list is small (tens to hundreds of words), so a
 * complete mirror is cheap and the lookup is synchronous.
 *
 * The backend remains the source of truth; this is a cache kept in step by
 * writing through it.
 */

import {
  customDictionaryAdd,
  customDictionaryList,
  customDictionaryRemove
} from '$lib/api/spellcheck';
import { invalidateDiagnostics } from './invalidate';

/**
 * Folded forms, for lookup. Matching is case-insensitive so a word added
 * mid-sentence in lowercase is not underlined again the moment it starts a
 * sentence — which is exactly when the user would notice and lose trust.
 */
let folded = $state(new Set<string>());
/** Original casing, for display in settings. */
let words = $state<string[]>([]);
let loaded = false;
/**
 * In-flight load, so concurrent callers share one fetch.
 *
 * `loaded` alone is not enough: it is set after the await, and the root
 * layout's startup load and the settings panel's effect can both start
 * before either finishes.
 */
let loading: Promise<void> | null = null;

const fold = (word: string) => word.trim().toLowerCase();

export const customDictionary = {
  get words(): string[] {
    return words;
  }
};

/** True when the user has accepted this word. Hot path — keep it synchronous. */
export function isCustomWord(word: string): boolean {
  return folded.has(fold(word));
}

export async function loadCustomDictionary(force = false): Promise<void> {
  if (loaded && !force) return;
  if (loading && !force) return loading;

  loading = (async () => {
    try {
      words = await customDictionaryList();
      folded = new Set(words.map(fold));
      loaded = true;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export async function addCustomWord(word: string): Promise<void> {
  const trimmed = word.trim();
  if (!trimmed || isCustomWord(trimmed)) return;

  // Update the mirror first so the re-check below already sees the word;
  // going the other way round would redraw the squiggle we just removed.
  folded = new Set(folded).add(fold(trimmed));
  words = [...words, trimmed].sort((a, b) => fold(a).localeCompare(fold(b)));

  await customDictionaryAdd(trimmed);
  invalidateDiagnostics();
}

export async function removeCustomWord(word: string): Promise<void> {
  const target = fold(word);
  const next = new Set(folded);
  next.delete(target);
  folded = next;
  words = words.filter((held) => fold(held) !== target);

  await customDictionaryRemove(word);
  invalidateDiagnostics();
}
