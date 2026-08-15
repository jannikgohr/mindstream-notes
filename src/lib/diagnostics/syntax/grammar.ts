/**
 * A syntax a plugin describes rather than one the app ships.
 *
 * The host knows Markdown and Typst because it has code for them. A plugin that
 * brings LaTeX, AsciiDoc or org-mode has no way to say "a `%` starts a comment
 * here" — its notes are either checked as Markdown, which is wrong, or not
 * checked at all. This closes that gap without letting a plugin ship code.
 *
 * DECLARATIVE, NOT A CALLBACK. Two reasons, and both are hard limits rather
 * than preferences. Plugins are declarative throughout — the host owns
 * execution — and this is the sharpest case of that rule, because these ranges
 * are recomputed on every keystroke over the whole document. The plugin runtime
 * is also in Rust, so a plugin-supplied function would mean an IPC round trip
 * per paragraph per keystroke.
 *
 * LITERAL DELIMITERS, NOT PATTERNS. A plugin-supplied regex is a plugin-supplied
 * hang: catastrophic backtracking on hot-path code freezes the editor, and no
 * amount of manifest validation reliably tells a safe pattern from an unsafe
 * one. Literal open/close strings express the constructs that actually matter —
 * comments, verbatim, math — and cost a bounded `startsWith` per character.
 *
 * WHAT IT CANNOT DO: mode nesting. Typst needs to know that `[...]` inside code
 * is prose again while `(...)` is not, and no list of delimiters expresses that
 * — which is why the host owns that scanner. A grammar describes languages whose
 * non-prose regions are delimited spans, which is most markup languages.
 */

import type { Segment, TextRange } from '../types';
import {
  ADDRESS_PATTERNS,
  lineIndentRanges,
  mergeRanges,
  overlapsAny,
  patternRanges
} from '../ignore-ranges';
import { splitParagraphs } from './segment';
import type { DiagnosticSyntax } from './types';

/** An open/close delimiter pair. Both are literal text, never patterns. */
export type DelimiterPair = readonly [open: string, close: string];

export interface DiagnosticGrammar {
  /** Markers that comment out the rest of the line, e.g. `%` or `//`. */
  lineComments?: readonly string[];
  /** Comment spans, e.g. C-style slash-star pairs. These do not nest. */
  blockComments?: readonly DelimiterPair[];
  /**
   * Spans that are code rather than prose — inline code, listings,
   * `\begin{verbatim}`.
   */
  verbatim?: readonly DelimiterPair[];
  /**
   * Math spans, e.g. `["$", "$"]`. Handled exactly like `verbatim`; kept apart
   * so a manifest reads as the language does.
   */
  math?: readonly DelimiterPair[];
  /**
   * The character that makes the next one literal, e.g. `\` so that `\%` does
   * not open a comment. One character.
   */
  escape?: string;
  /**
   * Ignore each line's leading whitespace.
   *
   * Only for languages where indentation MEANS something, since a checker's
   * doubled-space complaint is then about the document's structure rather than
   * the author's typing. Where leading spaces are just spaces, leaving this off
   * keeps a real typo visible.
   */
  indentation?: boolean;
  /** Skip URLs and email addresses. Defaults to true — they are never prose. */
  addresses?: boolean;
}

interface Opener {
  open: string;
  /** `null` for a line comment, which closes at the newline. */
  close: string | null;
}

/**
 * Openers bucketed by first character.
 *
 * The scanner asks "does anything start here?" at every character, so a flat
 * scan would be O(text × delimiters). Bucketing makes the common answer — no
 * opener begins with this letter — a single map lookup, and validation caps how
 * many delimiters can share a bucket.
 */
type Compiled = {
  byFirstChar: Map<string, Opener[]>;
  escape: string | null;
  indentation: boolean;
  addresses: boolean;
};

function compile(grammar: DiagnosticGrammar): Compiled {
  const openers: Opener[] = [];
  for (const open of grammar.lineComments ?? []) {
    if (open) openers.push({ open, close: null });
  }
  for (const pair of [
    ...(grammar.blockComments ?? []),
    ...(grammar.verbatim ?? []),
    ...(grammar.math ?? [])
  ]) {
    const [open, close] = pair;
    if (open && close) openers.push({ open, close });
  }

  const byFirstChar = new Map<string, Opener[]>();
  for (const opener of openers) {
    const bucket = byFirstChar.get(opener.open[0]);
    if (bucket) bucket.push(opener);
    else byFirstChar.set(opener.open[0], [opener]);
  }
  // Longest opener first, so `\begin{verbatim}` wins over `\` and `//` over `/`.
  for (const bucket of byFirstChar.values()) {
    bucket.sort((a, b) => b.open.length - a.open.length);
  }

  return {
    byFirstChar,
    escape: grammar.escape || null,
    indentation: grammar.indentation === true,
    addresses: grammar.addresses !== false
  };
}

/**
 * Every range of `text` the grammar says is not prose, sorted and merged.
 */
export function grammarIgnoreRanges(
  grammar: DiagnosticGrammar,
  text: string
): TextRange[] {
  const { byFirstChar, escape, indentation, addresses } = compile(grammar);
  const ranges: TextRange[] = [];

  let i = 0;
  while (i < text.length) {
    const c = text[i];

    // Openers are tested BEFORE the escape, because in the language that most
    // needs both they are the same character: LaTeX escapes with a backslash
    // and opens its verbatim environment with one too. Escape-first would eat
    // the backslash and the letter after it, so the listing that followed
    // would be checked as prose. A delimiter that matches here is a delimiter;
    // anything else the escape character starts is an escape.
    const bucket = byFirstChar.get(c);
    const opener = bucket?.find((o) => text.startsWith(o.open, i));

    if (opener === undefined) {
      // The escape and the character it protects are both prose; consuming
      // the pair is what stops `\%` from opening a comment.
      i += escape !== null && c === escape ? 2 : 1;
      continue;
    }

    const end = spanEnd(text, i, opener);
    ranges.push({ from: i, to: end });
    i = end;
  }

  const merged = mergeRanges([
    ...ranges,
    ...(indentation ? lineIndentRanges(text) : [])
  ]);
  if (!addresses) return merged;

  // Applied to what the grammar left as prose, so a URL inside a comment does
  // not produce a second overlapping range.
  const found = patternRanges(text, ADDRESS_PATTERNS).filter(
    (range) => !overlapsAny(range, merged)
  );
  return mergeRanges([...merged, ...found]);
}

/**
 * End of the span opened at `from`, past its closing delimiter.
 *
 * An unterminated span runs to the end of the text rather than to the next
 * thing that looks like a closer — half-typed markup is the steady state while
 * writing, and guessing a closer would move squiggles onto text the user is
 * still in the middle of.
 */
function spanEnd(text: string, from: number, opener: Opener): number {
  const contentStart = from + opener.open.length;
  if (opener.close === null) {
    const nl = text.indexOf('\n', contentStart);
    return nl === -1 ? text.length : nl;
  }
  const close = text.indexOf(opener.close, contentStart);
  return close === -1 ? text.length : close + opener.close.length;
}

/**
 * Compiled grammars, keyed by the manifest object that described them.
 *
 * The registry hands out the same frozen contribution object for the life of a
 * plugin, so this rebuilds a grammar's lookup tables once rather than on every
 * editor reconfiguration.
 */
const cache = new WeakMap<DiagnosticGrammar, DiagnosticSyntax>();

/** A `DiagnosticSyntax` backed by a plugin-declared grammar. */
export function createGrammarSyntax(
  grammar: DiagnosticGrammar
): DiagnosticSyntax {
  const hit = cache.get(grammar);
  if (hit) return hit;

  const syntax: DiagnosticSyntax = {
    id: 'grammar',
    ignoreRanges: (text: string) => grammarIgnoreRanges(grammar, text),
    segment: (text: string): Segment[] => splitParagraphs(text)
  };
  cache.set(grammar, syntax);
  return syntax;
}
