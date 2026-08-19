/**
 * Ordering spelling suggestions by how likely they are to be what the user
 * meant.
 *
 * spellbook (like Nuspell and Hunspell before it) emits suggestions in
 * GENERATION order — case variants first, then deletions, then
 * substitutions, then insertions — which is an artefact of how they are
 * produced and carries no notion of relevance. For `Nr` that yields
 * `NR, R, N, Er, Ne, Ni, Na, …` with `Nr.`, the obvious intended word,
 * somewhere near the bottom. Users read the first two or three entries and
 * conclude the checker is useless.
 *
 * Only applied to suggestions we fetched ourselves. A provider that ships
 * its own `replacements` (LanguageTool ranks by rule confidence, which we
 * cannot reconstruct from the strings alone) keeps its order.
 */

/** Cost of an insertion, deletion or substitution. */
export const EDIT = 10;

/**
 * Cost of a transposition — deliberately cheaper than any other single
 * edit.
 *
 * Swapped adjacent letters are the most common typing error there is, and
 * scoring them equal to a substitution loses `teh` -> `the` to `teh` ->
 * `ten`: both are one edit, and `ten` even shares the longer prefix. Making
 * a transposition strictly cheaper settles it on the edit itself rather
 * than leaving it to a tie-break that happens to point the wrong way.
 */
export const TRANSPOSE = 9;

/**
 * Weighted Damerau-Levenshtein cost, CASE-SENSITIVE.
 *
 * Returned in units of `EDIT` per ordinary edit rather than a plain count,
 * so a transposition can rank between "identical" and "one edit away"
 * without floating-point comparisons.
 *
 * Case sensitivity is deliberate and load-bearing. Folding case first makes
 * `NR` a cost-0 match for `Nr` and therefore the top suggestion, which is
 * exactly the wrong answer — a case flip is a real edit the user is
 * unlikely to have intended. Counting it puts `NR` level with every other
 * one-character change, where the prefix tie-break can then prefer `Nr.`
 */
export function editCost(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  // Two-dimensional walk, but transposition needs the row before last, so
  // all three are kept rather than the usual two.
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: cols }, (_, i) => i * EDIT);
  let current: number[] = [];

  for (let i = 1; i < rows; i++) {
    current = new Array<number>(cols);
    current[0] = i * EDIT;
    for (let j = 1; j < cols; j++) {
      const substitution = a[i - 1] === b[j - 1] ? 0 : EDIT;
      let value = Math.min(
        current[j - 1] + EDIT, // insertion
        prev[j] + EDIT, // deletion
        prev[j - 1] + substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prev2[j - 2] + TRANSPOSE);
      }
      current[j] = value;
    }
    prev2 = prev;
    prev = current;
  }

  return prev[cols - 1];
}

/** Length of the longest shared prefix, case-sensitive. */
export function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/**
 * Rank `suggestions` for `word`, best first.
 *
 * Sorted by edit cost, then by shared prefix, then by how close the lengths
 * are, and finally by the engine's original order so its own (weak) signal
 * breaks remaining ties rather than something arbitrary.
 *
 * The prefix term is what actually decides the common case: when a word is
 * short, almost every candidate is one edit away, so cost alone leaves a
 * large tie and the winner is whatever the engine happened to emit first.
 */
export function rankSuggestions(word: string, suggestions: string[]): string[] {
  return suggestions
    .map((suggestion, index) => ({
      suggestion,
      index,
      cost: editCost(word, suggestion),
      prefix: commonPrefixLength(word, suggestion),
      lengthDelta: Math.abs(word.length - suggestion.length)
    }))
    .sort(
      (a, b) =>
        a.cost - b.cost ||
        b.prefix - a.prefix ||
        a.lengthDelta - b.lengthDelta ||
        a.index - b.index
    )
    .map((entry) => entry.suggestion);
}
