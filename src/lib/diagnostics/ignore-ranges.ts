/**
 * Regions of a Markdown document that must never be spellchecked.
 *
 * The single biggest source of noise in a naive spellchecker is checking
 * text that isn't prose: code, URLs, math, YAML keys. A note with three
 * code blocks would come back speckled with red, and the user would
 * (correctly) conclude the feature is broken.
 *
 * SCOPE: this module works on Markdown SOURCE text, so it serves the
 * CodeMirror surface and anything else holding raw markdown. The WYSIWYG
 * surface does not use it — there, the same information is available
 * structurally and far more reliably from the ProseMirror document (code
 * marks, `code_block` nodes, math nodes, link marks), so its plugin
 * derives skips by walking the doc instead of re-parsing text. Two
 * implementations, but each uses the best signal its surface has, which
 * is the same split the editor plugins already follow.
 */

import type { TextRange } from './types';

/** Sort, then coalesce overlapping and adjacent ranges into a minimal set. */
export function mergeRanges(ranges: TextRange[]): TextRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: TextRange[] = [{ ...sorted[0] }];
  for (const r of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (r.from <= last.to) {
      last.to = Math.max(last.to, r.to);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** True when `range` overlaps any range in the (sorted, merged) list. */
export function overlapsAny(range: TextRange, ranges: TextRange[]): boolean {
  // Linear scan: these lists are short (a handful per paragraph) and a
  // binary search would cost more in complexity than it saves.
  return ranges.some((r) => range.from < r.to && r.from < range.to);
}

/**
 * Fenced code blocks and YAML frontmatter, found by scanning lines.
 *
 * Deliberately line-based rather than one big regex: fences can contain
 * absolutely anything, including unbalanced backticks and text that looks
 * like a closing fence, and a regex that gets this wrong silently
 * un-ignores half a document. Lines are also how the Markdown spec
 * defines them.
 */
function blockRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  const lines = text.split('\n');

  let offset = 0;
  let fence: { marker: string; start: number } | null = null;
  let inFrontmatter = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1; // + newline

    const trimmed = line.trim();

    // Frontmatter is only frontmatter on line 0 — a `---` anywhere else is
    // a thematic break.
    if (i === 0 && trimmed === '---') {
      inFrontmatter = true;
      ranges.push({ from: lineStart, to: lineEnd });
      continue;
    }
    if (inFrontmatter) {
      ranges.push({ from: lineStart, to: lineEnd });
      if (trimmed === '---' || trimmed === '...') inFrontmatter = false;
      continue;
    }

    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fence === null) {
      if (fenceMatch) fence = { marker: fenceMatch[1][0], start: lineStart };
      if (fence) ranges.push({ from: lineStart, to: lineEnd });
      continue;
    }

    ranges.push({ from: lineStart, to: lineEnd });
    // A closing fence must use the same character as the opener; a ``` line
    // inside a ~~~ block is content, not a terminator.
    if (fenceMatch && fenceMatch[1][0] === fence.marker) fence = null;
  }

  return ranges;
}

/**
 * URLs and email addresses, which are never prose in any syntax.
 *
 * Split out from the Markdown-specific list because every other syntax
 * needs exactly these two and nothing else around them: a Typst document,
 * a Kanban card description and a Markdown note all contain links a
 * dictionary would otherwise flag word by word. Shared so the three cannot
 * drift into disagreeing about what a URL looks like.
 */
export const ADDRESS_PATTERNS: readonly RegExp[] = [
  /\b(?:https?:\/\/|www\.)[^\s<>()[\]]+/gi, // bare URL
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g // bare email
];

/** Every match of every pattern, as ranges. Patterns must be global. */
export function patternRanges(
  text: string,
  patterns: readonly RegExp[]
): TextRange[] {
  const ranges: TextRange[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      const from = m.index ?? 0;
      ranges.push({ from, to: from + m[0].length });
    }
  }
  return ranges;
}

/**
 * Inline constructs to skip. Each is applied to the whole document but
 * matches overlapping a block range are dropped — a fence already covers
 * that text, and a pattern that straddles a fence boundary is a
 * mis-parse rather than a real construct.
 */
const INLINE_PATTERNS: readonly RegExp[] = [
  /(`+)(?:(?!\1)[\s\S])*?\1/g, // inline code, honouring the opening run length
  /\$\$[\s\S]*?\$\$/g, // block math
  /\$[^$\n]+\$/g, // inline math
  /\[\[[^\][\n]*\]\]/g, // wikilinks — the target is an id/title, not prose
  /(?<![\w@])@[A-Za-z0-9._-]+/g, // @mentions
  /<[^\s<>]+@[^\s<>]+>/g, // autolinked email
  /<[a-zA-Z][^\s<>]*:\/\/[^\s<>]*>/g, // autolinked URL
  ...ADDRESS_PATTERNS,
  /<\/?[A-Za-z][^>]*>/g // inline HTML tag
];

/**
 * Link and image destinations: `[text](url)` must check `text` but never
 * `url`. Handled apart from INLINE_PATTERNS because only the capture group
 * is ignored, not the whole match.
 */
const LINK_DESTINATION = /\]\(\s*([^)\s]*)/g;

/** Reference definitions — `[label]: https://…` — where only the URL is skipped. */
const REFERENCE_DEFINITION = /^[ \t]*\[[^\]\n]+\]:[ \t]*(\S+)/gm;

/**
 * Every range in `text` that should NOT be spellchecked, sorted and merged.
 */
export function ignoreRanges(text: string): TextRange[] {
  const blocks = mergeRanges(blockRanges(text));
  const found: TextRange[] = [...blocks];

  for (const pattern of INLINE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      const from = m.index ?? 0;
      const range = { from, to: from + m[0].length };
      if (!overlapsAny(range, blocks)) found.push(range);
    }
  }

  for (const pattern of [LINK_DESTINATION, REFERENCE_DEFINITION]) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      const url = m[1];
      if (!url) continue;
      const from = (m.index ?? 0) + m[0].length - url.length;
      const range = { from, to: from + url.length };
      if (!overlapsAny(range, blocks)) found.push(range);
    }
  }

  return mergeRanges(found);
}

/** Drop every item whose range overlaps an ignored region. */
export function excludeIgnored<T extends TextRange>(
  items: T[],
  ranges: TextRange[]
): T[] {
  if (ranges.length === 0) return items;
  return items.filter((item) => !overlapsAny(item, ranges));
}

/**
 * Blank out ignored regions, preserving every offset.
 *
 * Filtering findings AFTER a check is enough when the checker is local, but
 * a network checker has already been sent the text by then — so a note's
 * code blocks would reach a LanguageTool server only to have their results
 * discarded. Masking first means they are never transmitted, and the
 * dropped-results path becomes belt and braces rather than the only guard.
 *
 * Replacement is space-for-character so positions stay valid: a masked
 * region cannot shift the text after it, and a fenced code block collapses
 * to blank lines, which paragraph segmentation then skips on its own.
 */
export function maskRanges(text: string, ranges: TextRange[]): string {
  if (ranges.length === 0) return text;
  const chars = [...text];
  for (const { from, to } of ranges) {
    for (let i = Math.max(0, from); i < Math.min(chars.length, to); i++) {
      // Newlines survive so line structure — and paragraph splitting — is
      // unchanged by masking.
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  return chars.join('');
}
