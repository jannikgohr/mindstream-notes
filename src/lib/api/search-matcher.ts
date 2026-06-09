/**
 * Pure TS port of the Rust search matcher. Two consumers:
 *
 *   1. The browser-fallback mock store — when running `pnpm dev` outside
 *      Tauri there's no Rust binary to call, so we mirror the same logic
 *      against the in-memory note pool.
 *
 *   2. Frontend helpers like `splitByRanges()` for rendering highlight
 *      spans on the dialog list.
 *
 * The Rust side (src-tauri/src/search/mod.rs) is the source of truth.
 * Keep this file's behaviour aligned: AND semantics on whitespace-split
 * terms, case-insensitive match, +10/title-hit +1/body-hit scoring,
 * 200-char snippet around the first body match.
 */

import type { MatchRange, SearchHit } from './search';

const SNIPPET_PRE_CHARS = 40;
const SNIPPET_LEN_CHARS = 200;

export interface MatchableNote {
  title: string;
  body: string;
  tags: string[];
}

export function tokenizeQuery(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

export function findMatches(haystack: string, terms: string[]): MatchRange[] {
  if (terms.length === 0 || haystack.length === 0) return [];
  const lower = haystack.toLowerCase();
  const raw: Array<[number, number]> = [];
  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(term, from);
      if (idx === -1) break;
      raw.push([idx, idx + term.length]);
      from = idx + term.length;
    }
  }
  return mergeRanges(raw);
}

function mergeRanges(raw: Array<[number, number]>): MatchRange[] {
  if (raw.length === 0) return [];
  raw.sort((a, b) => a[0] - b[0]);
  const out: MatchRange[] = [];
  let [cs, ce] = raw[0];
  for (let i = 1; i < raw.length; i++) {
    const [s, e] = raw[i];
    if (s <= ce) {
      if (e > ce) ce = e;
    } else {
      out.push({ start: cs, end: ce });
      cs = s;
      ce = e;
    }
  }
  out.push({ start: cs, end: ce });
  return out;
}

function countMatches(lower: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let from = 0;
  while (from < lower.length) {
    const idx = lower.indexOf(term, from);
    if (idx === -1) break;
    count += 1;
    from = idx + term.length;
  }
  return count;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function buildSnippet(
  body: string,
  terms: string[]
): { snippet: string; matches: MatchRange[] } {
  if (!body) return { snippet: '', matches: [] };
  const bodyLower = body.toLowerCase();
  let firstMatch: number | null = null;
  for (const term of terms) {
    if (!term) continue;
    const idx = bodyLower.indexOf(term);
    if (idx === -1) continue;
    firstMatch = firstMatch === null ? idx : Math.min(firstMatch, idx);
  }
  const start =
    firstMatch === null ? 0 : Math.max(0, firstMatch - SNIPPET_PRE_CHARS);
  const end = Math.min(body.length, start + SNIPPET_LEN_CHARS);

  const rawSnippet = body.slice(start, end);
  const inner = collapseWhitespace(rawSnippet);

  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  const innerMatches = findMatches(inner, terms);
  const shifted = innerMatches.map((m) => ({
    start: m.start + prefix.length,
    end: m.end + prefix.length
  }));

  return { snippet: `${prefix}${inner}${suffix}`, matches: shifted };
}

/**
 * Score and rank an iterable of notes against the query. Used both by
 * the mock store and (potentially) any future TS-only search caller.
 */
export function scoreNotes<T extends MatchableNote>(
  notes: T[],
  query: string
): Array<{
  note: T;
  score: number;
  snippet: string;
  titleMatches: MatchRange[];
  snippetMatches: MatchRange[];
}> {
  const terms = tokenizeQuery(query);
  if (terms.length === 0) return [];

  const out: Array<{
    note: T;
    score: number;
    snippet: string;
    titleMatches: MatchRange[];
    snippetMatches: MatchRange[];
  }> = [];

  for (const n of notes) {
    const titleLower = n.title.toLowerCase();
    const bodyLower = n.body.toLowerCase();
    const tagsLower = n.tags.join(' ').toLowerCase();
    const allPresent = terms.every(
      (t) =>
        titleLower.includes(t) || bodyLower.includes(t) || tagsLower.includes(t)
    );
    if (!allPresent) continue;

    const titleMatches = findMatches(n.title, terms);
    const bodyMatchCount = terms.reduce(
      (acc, t) => acc + countMatches(bodyLower, t),
      0
    );
    const score = titleMatches.length * 10 + bodyMatchCount;
    const { snippet, matches } = buildSnippet(n.body, terms);
    out.push({
      note: n,
      score,
      snippet,
      titleMatches,
      snippetMatches: matches
    });
  }

  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const am = (a.note as unknown as { modified?: string }).modified ?? '';
    const bm = (b.note as unknown as { modified?: string }).modified ?? '';
    return bm.localeCompare(am);
  });

  return out;
}

/**
 * Split a string by match ranges into a list of `{ text, highlight }`
 * segments so the dialog can render highlighted spans without parsing
 * the ranges inline.
 */
export function splitByRanges(
  text: string,
  ranges: MatchRange[]
): Array<{ text: string; highlight: boolean }> {
  if (ranges.length === 0) return [{ text, highlight: false }];
  const out: Array<{ text: string; highlight: boolean }> = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) {
      out.push({ text: text.slice(cursor, r.start), highlight: false });
    }
    out.push({ text: text.slice(r.start, r.end), highlight: true });
    cursor = r.end;
  }
  if (cursor < text.length) {
    out.push({ text: text.slice(cursor), highlight: false });
  }
  return out;
}

/**
 * Drive a full mock search end-to-end so the in-memory store can reuse
 * the same scoring and snippet logic as the Rust side.
 */
export function mockSearchNotes(
  notes: MatchableNote[],
  query: string
): SearchHit[] {
  const ranked = scoreNotes(notes, query);
  return ranked.map((r) => ({
    note: r.note as unknown as SearchHit['note'],
    snippet: r.snippet,
    title_matches: r.titleMatches,
    snippet_matches: r.snippetMatches
  }));
}
