/**
 * Search API. Mirror of src-tauri/src/search/mod.rs.
 *
 * `searchNotes(query)` returns scored hits with a body snippet and
 * char-index match ranges for highlight rendering. Browser fallback
 * (`pnpm dev` without Tauri) implements the same matcher in TS over the
 * mock note store so the dialog stays usable in dev.
 */

import {
  assertNumber,
  assertRecord,
  assertString,
  TauriCommandName,
  invokeOrFallback
} from './core';
import { mockApi } from './mock-store';
import { parseNoteSummary, type NoteSummary } from './notes';

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
  return invokeOrFallback<SearchHit[]>(
    TauriCommandName.SearchNotes,
    { query },
    () => mockApi.searchNotes(query),
    parseSearchHits
  );
}

function parseMatchRange(value: unknown): MatchRange {
  const raw = assertRecord(value, 'match range');
  return {
    start: assertNumber(raw.start, 'match range.start'),
    end: assertNumber(raw.end, 'match range.end')
  };
}

function parseMatchRanges(value: unknown, context: string): MatchRange[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value.map(parseMatchRange);
}

function parseSearchHit(value: unknown): SearchHit {
  const raw = assertRecord(value, 'search hit');
  return {
    note: parseNoteSummary(raw.note),
    snippet: assertString(raw.snippet, 'search hit.snippet'),
    title_matches: parseMatchRanges(
      raw.title_matches,
      'search hit.title_matches'
    ),
    snippet_matches: parseMatchRanges(
      raw.snippet_matches,
      'search hit.snippet_matches'
    )
  };
}

function parseSearchHits(value: unknown): SearchHit[] {
  if (!Array.isArray(value))
    throw new Error('search response must be an array');
  return value.map(parseSearchHit);
}
