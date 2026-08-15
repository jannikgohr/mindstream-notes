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
 * TWO TIERS, SPLIT BY WHAT CAN BE BOUNDED. Literal open/close delimiters cost a
 * bounded `startsWith` per character, so they run inline on the editor thread.
 * Patterns cannot be bounded — no analysis reliably separates a safe regex from
 * one that backtracks catastrophically, and star-height checks miss cases as
 * ordinary as `(a|ab)*` — so they run in a Worker that is TERMINATED if it
 * overruns its budget. Killing the thread is the only thing that actually stops
 * a runaway match in JavaScript; timing it afterwards prevents the second
 * freeze, never the first.
 *
 * That mirrors the contract scripted plugins already get, where `limits.timeoutMs`
 * and `catch_unwind` mean a plugin fault costs the plugin rather than the app.
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
import { grammarFaulted, runGrammar } from './grammar-runner';
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
  /**
   * Patterns for constructs no pair of delimiters can describe.
   *
   * The gap these fill is real, and LaTeX shows it immediately: a bold command
   * must lose its name and KEEP its argument, which a delimiter pair cannot
   * express — it either swallows the prose or leaves the command to the
   * dictionary. A pattern says it exactly, and one of them replaces the dozens
   * of pairs that ref, cite and label commands would otherwise need.
   *
   * CAPTURE GROUPS SCOPE THE IGNORE. With no group, the whole match is
   * skipped; with groups, only the groups are — so a pattern that captures the
   * command name and then matches the opening brace drops the command and
   * still checks its argument. Same convention the host's own Markdown rules
   * use for link destinations.
   *
   * These run in a Worker with a hard timeout, never on the thread drawing the
   * editor — see `grammar-runner.ts`. A pattern that backtracks catastrophically
   * is a frozen editor otherwise, and that is a mistake to make by accident far
   * more easily than by malice.
   */
  ignorePatterns?: readonly string[];
}

/**
 * Compile a plugin's pattern with host-chosen flags.
 *
 * `d` because capture-group scoping needs `match.indices`; searching for the
 * captured text instead would find the wrong occurrence. `g` to walk every
 * match. `u` when the pattern accepts it, so `\p{L}` works for languages the
 * ASCII classes do not cover — and dropped when it does not, since Unicode mode
 * rejects escapes that are legal in the default mode.
 *
 * Shared by validation and the scanner so a manifest can never be accepted
 * under flags different from the ones it will actually run under.
 */
export function compilePattern(source: string): RegExp {
  try {
    return new RegExp(source, 'gdu');
  } catch {
    return new RegExp(source, 'gd');
  }
}

/**
 * Ranges from one pattern, honouring the capture-group convention.
 *
 * Zero-length matches are dropped rather than recorded: they mark a position
 * rather than cover text, and a range that ignores nothing is only a range the
 * rest of the pipeline has to defend against.
 */
function patternMatches(pattern: RegExp, text: string): TextRange[] {
  const ranges: TextRange[] = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const groups = match.indices?.slice(1) ?? [];
    if (groups.length > 0) {
      for (const at of groups) {
        if (at && at[1] > at[0]) ranges.push({ from: at[0], to: at[1] });
      }
      continue;
    }
    if (match[0].length > 0) {
      ranges.push({ from: match.index, to: match.index + match[0].length });
    }
  }
  return ranges;
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
 *
 * Includes the patterns, so this is the function the Worker calls. Callers on
 * the editor thread must NOT reach it with a grammar that has patterns — see
 * `createGrammarSyntax`, which routes those through `grammar-runner`.
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

  for (const source of grammar.ignorePatterns ?? []) {
    try {
      ranges.push(...patternMatches(compilePattern(source), text));
    } catch {
      // Validation already compiled every pattern, so reaching here means the
      // engine disagreed with itself. Skipping one pattern degrades the answer;
      // throwing would lose the whole document's ranges.
    }
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

/**
 * A `DiagnosticSyntax` backed by a plugin-declared grammar.
 *
 * Patterns decide how it runs. Without them the grammar is delimiters, which
 * cost a bounded `startsWith` per character and stay inline and synchronous.
 * With them it goes through the Worker, and if that cannot answer — no Worker
 * in this environment, or the grammar already overran its budget — it degrades
 * to the delimiters rather than to nothing. A document keeps the squiggles the
 * safe half of its grammar can justify.
 *
 * `onFault` is how that degradation becomes visible. This module knows nothing
 * about plugins, so the caller supplies the reporting; see
 * `sourceLanguageDiagnosticSyntax`.
 */
export function createGrammarSyntax(
  grammar: DiagnosticGrammar,
  onFault?: (reason: string) => void
): DiagnosticSyntax {
  const hit = cache.get(grammar);
  if (hit) return hit;

  const hasPatterns = (grammar.ignorePatterns?.length ?? 0) > 0;
  const delimitersOnly: DiagnosticGrammar = {
    ...grammar,
    ignorePatterns: undefined
  };

  const syntax: DiagnosticSyntax = {
    id: 'grammar',
    ignoreRanges: hasPatterns
      ? async (text: string) => {
          const isolated = await runGrammar(grammar, text);
          if (isolated) return isolated;
          if (!reported) {
            reported = true;
            onFault?.(
              grammarFaulted(grammar)
                ? 'a diagnostics pattern exceeded its time budget and was stopped; only the grammar delimiters are used'
                : 'diagnostics patterns cannot run here; only the grammar delimiters are used'
            );
          }
          return grammarIgnoreRanges(delimitersOnly, text);
        }
      : (text: string) => grammarIgnoreRanges(grammar, text),
    segment: (text: string): Segment[] => splitParagraphs(text)
  };
  // Reported once per grammar: the fallback happens on every keystroke, and a
  // message per keystroke would bury the one that mattered.
  let reported = false;
  cache.set(grammar, syntax);
  return syntax;
}
