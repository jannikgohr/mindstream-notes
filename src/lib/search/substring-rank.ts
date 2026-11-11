/**
 * Keep the items whose text contains `query`, ranked for a typeahead: prefix
 * matches first, then earlier matches, then shorter text. Ties keep input
 * order. The caller trims and lowercases `query`.
 */
export function rankSubstringMatches<T>(
  items: readonly T[],
  query: string,
  textOf: (item: T) => string,
  limit: number
): T[] {
  const ranked: Array<{ item: T; rank: number }> = [];
  for (const item of items) {
    const text = textOf(item).toLowerCase();
    const idx = text.indexOf(query);
    if (idx < 0) continue;
    ranked.push({ item, rank: idx === 0 ? 0 : idx + text.length / 1000 });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((entry) => entry.item);
}
