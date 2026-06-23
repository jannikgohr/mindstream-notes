/**
 * Search API. Mirror of src-tauri/src/search/mod.rs.
 *
 * `searchNotes(query)` returns scored hits with a body snippet and
 * char-index match ranges for highlight rendering. Browser fallback
 * (`pnpm dev` without Tauri) implements the same matcher in TS over the
 * mock note store so the dialog stays usable in dev.
 */

import { invokeOrFallback } from './core';
import { mockApi } from './mock-store';
import type { NoteSummary } from './notes';

export interface MatchRange {
  start: number;
  end: number;
}

export interface SearchHit {
  note: NoteSummary;
  snippet: string;
  title_matches: MatchRange[];
  snippet_matches: MatchRange[];
}

export function searchNotes(query: string): Promise<SearchHit[]> {
  return invokeOrFallback<SearchHit[]>('search_notes', { query }, () =>
    mockApi.searchNotes(query)
  );
}
