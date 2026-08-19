/**
 * Finding the prose in a Typst document.
 *
 * Typst is not Markdown with different punctuation. A Typst file is a
 * two-mode language: markup mode, where text is text, and code mode, entered
 * with `#`, where text is identifiers, keywords, units and paths. A typical
 * document opens with a block of `#set` and `#show` rules and `#import`s that
 * contain no prose whatsoever, and running a dictionary over it flags nearly
 * every token — `pagebreak`, `justify`, `lang`, `preview`, `cetz`. That is the
 * false-positive flood the user asked to stop.
 *
 * Regexes cannot answer this. The two modes nest without bound and in both
 * directions: `#figure(caption: [The *sample* rate], image("a.png"))` is code
 * containing markup containing code, and the only way to know that `sample` is
 * prose while `image` is not is to have tracked how you got there. So this is a
 * scanner with a mode stack rather than a pattern list, and it is the one place
 * in the diagnostics pipeline that needed to be.
 *
 * THE RULE IT IMPLEMENTS: everything is ignored except markup mode. Code,
 * math, raw blocks, comments, string literals, labels and references are all
 * skipped; content blocks — `[...]` in code — are prose again, however deep.
 *
 * It is deliberately an approximation of Typst's grammar, not a
 * re-implementation. The one place that shows is where a code expression ends:
 * Typst decides by parsing a complete expression, and this decides by keyword
 * and bracket depth (see `expressionEnds`). Both possible mistakes are
 * survivable and only one is even visible — ignoring a little prose costs a
 * missed typo, which is the trade the whole feature already makes in favour of
 * silence.
 *
 * Host-owned, like the Typst CodeMirror mode it sits beside: the Typst plugin
 * opts its note kind in, the app decides what Typst means. See
 * `$lib/diagnostics/syntax/types.ts`.
 */

import type { TextRange } from '../types';
import {
  ADDRESS_PATTERNS,
  mergeRanges,
  overlapsAny,
  patternRanges
} from '../ignore-ranges';

/**
 * Keywords whose statement runs to the end of the line rather than to the
 * next space.
 *
 * Without this, `#set text(size: 10pt)` would leave code mode at the space
 * after `set` and check `text` as prose — which is precisely the noise on the
 * configuration block at the top of every document. `#import` and `#include`
 * matter for the same reason; the control-flow keywords are here because their
 * bodies are content blocks that this scanner wants to reach in code context,
 * not as loose markup.
 */
const STATEMENT_KEYWORDS = new Set([
  'let',
  'set',
  'show',
  'import',
  'include',
  'if',
  'else',
  'for',
  'while',
  'context',
  'return'
]);

const IDENT_START = /[\p{L}_]/u;
const IDENT_CHAR = /[\p{L}\p{N}_-]/u;

/** A label — `<intro>` — names an anchor, never prose. */
const LABEL = /^<[\p{L}_][\p{L}\p{N}_.:-]*>/u;

/** A reference — `@knuth1984` — names a bibliography key, never prose. */
const REFERENCE = /^@[\p{L}_][\p{L}\p{N}_.:-]*/u;

interface Frame {
  mode: 'markup' | 'code';
  /**
   * Code: nesting of `(`/`{`. Markup: nesting of literal `[` inside a content
   * block, so the `]` that closes the block is told apart from one that does
   * not.
   */
  depth: number;
  /** Code only: this frame is a statement, so it ends at the line, not the space. */
  statement: boolean;
}

/**
 * Every range of a Typst document that must not be spellchecked, sorted and
 * merged.
 */
export function typstIgnoreRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  const stack: Frame[] = [{ mode: 'markup', depth: 0, statement: false }];

  /** Start of the run of non-prose we are currently inside, if any. */
  let skipping: number | null = null;

  const top = () => stack[stack.length - 1];

  /**
   * Reconcile the skip run with the mode we are now in, at `pos`.
   *
   * Called after every push and pop rather than at each construct, so a
   * boundary is recorded once and in one place no matter which transition
   * produced it.
   */
  const sync = (pos: number) => {
    if (top().mode === 'markup') {
      if (skipping !== null && pos > skipping) {
        ranges.push({ from: skipping, to: pos });
      }
      skipping = null;
    } else if (skipping === null) {
      skipping = pos;
    }
  };

  /** A construct that is not prose even though markup mode surrounds it. */
  const skip = (from: number, to: number) => {
    if (top().mode === 'markup') ranges.push({ from, to });
  };

  /**
   * Leave the current code frame, if there is one to leave.
   *
   * Returns false when the frame is the document's own, which happens on
   * stray closers in text a user is midway through typing. The caller then
   * treats the character as ordinary and moves on — popping the last frame
   * would leave the scanner with no mode at all.
   */
  const leaveCode = (pos: number): boolean => {
    if (stack.length === 1) return false;
    stack.pop();
    sync(pos);
    return true;
  };

  let i = 0;
  while (i < text.length) {
    const frame = top();
    const c = text[i];

    // Comments read the same in both modes and win over everything else —
    // `//` inside markup is a comment, not two slashes. The exception is the
    // `//` in `https://`, which Typst's own lexer special-cases too; without
    // it a link would comment out the rest of its line, and the words after it
    // would go unchecked with nothing on screen to say why.
    if (c === '/' && text[i + 1] === '/' && text[i - 1] !== ':') {
      const end = lineEnd(text, i);
      skip(i, end);
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = blockCommentEnd(text, i);
      skip(i, end);
      i = end;
      continue;
    }

    if (frame.mode === 'markup') {
      // An escape makes the next character literal text, including `#`, `[`
      // and `$` — consuming both keeps it from opening a mode it doesn't.
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        const end = rawEnd(text, i);
        skip(i, end);
        i = end;
        continue;
      }
      if (c === '$') {
        const end = mathEnd(text, i);
        skip(i, end);
        i = end;
        continue;
      }
      if (c === '<') {
        const m = LABEL.exec(text.slice(i));
        if (m) {
          skip(i, i + m[0].length);
          i += m[0].length;
          continue;
        }
      }
      if (c === '@') {
        const m = REFERENCE.exec(text.slice(i));
        if (m) {
          skip(i, i + m[0].length);
          i += m[0].length;
          continue;
        }
      }
      if (c === '#') {
        const opened = openCode(text, i, stack);
        if (opened !== null) {
          sync(i);
          i = opened;
          continue;
        }
      }
      // Brackets are literal in markup, but a content block reached from code
      // ends at the `]` that balances it — so count on the way in to tell the
      // two apart.
      if (c === '[') {
        frame.depth++;
        i++;
        continue;
      }
      if (c === ']') {
        if (frame.depth > 0) {
          frame.depth--;
          i++;
          continue;
        }
        if (stack.length > 1) {
          stack.pop();
          // The `]` itself belongs to the enclosing code expression.
          sync(i);
          i++;
          continue;
        }
        // Unbalanced in a top-level document: literal text.
        i++;
        continue;
      }
      i++;
      continue;
    }

    // ---- code mode ------------------------------------------------------
    if (c === '"') {
      i = stringEnd(text, i);
      continue;
    }
    if (c === '(' || c === '{') {
      frame.depth++;
      i++;
      continue;
    }
    if (c === ')' || c === '}') {
      if (frame.depth > 0) {
        frame.depth--;
        i++;
        // `#f(...)` is complete once its arguments close, unless a chained
        // call, field access or content block follows.
        if (frame.depth === 0 && !frame.statement && !continues(text, i)) {
          leaveCode(i);
        }
        continue;
      }
      // Closes a group this frame never opened — hand the character back to
      // whatever did.
      if (!leaveCode(i)) i++;
      continue;
    }
    if (c === '[') {
      stack.push({ mode: 'markup', depth: 0, statement: false });
      // The bracket is code; the prose starts after it.
      sync(i + 1);
      i++;
      continue;
    }
    if (c === ']') {
      if (!leaveCode(i)) i++;
      continue;
    }
    if (expressionEnds(text, i, frame)) {
      if (!leaveCode(i)) i++;
      continue;
    }
    i++;
  }

  // A document that ends mid-code — the common case while typing — closes its
  // skip run at the end of the text rather than losing it.
  if (skipping !== null && skipping < text.length) {
    ranges.push({ from: skipping, to: text.length });
  }

  // URLs are markup-mode text that is still not prose. Applied afterwards and
  // only where the scanner left prose, so a URL inside a comment or a string
  // does not produce a second overlapping range.
  const merged = mergeRanges(ranges);
  const addresses = patternRanges(text, ADDRESS_PATTERNS).filter(
    (range) => !overlapsAny(range, merged)
  );
  return mergeRanges([...merged, ...addresses]);
}

/**
 * Enter code mode at a `#`, returning the position to resume from, or `null`
 * when the `#` is literal text.
 *
 * `#` only opens code when something can follow it — an identifier, a group or
 * a block. A bare `#` before a space, or at the end of a line, is a hash the
 * user typed.
 */
function openCode(text: string, hash: number, stack: Frame[]): number | null {
  const next = text[hash + 1];
  if (next === undefined) return null;

  if (next === '(' || next === '{') {
    stack.push({ mode: 'code', depth: 1, statement: false });
    return hash + 2;
  }
  if (!IDENT_START.test(next)) return null;

  let end = hash + 1;
  while (end < text.length && IDENT_CHAR.test(text[end])) end++;
  const word = text.slice(hash + 1, end);
  stack.push({
    mode: 'code',
    depth: 0,
    statement: STATEMENT_KEYWORDS.has(word)
  });
  return end;
}

/**
 * Whether a code expression that just closed its brackets keeps going.
 *
 * `#f(1)(2)`, `#f(1).len()` and `#emph[x]` are all one expression; `#f(1) and`
 * is an expression followed by prose.
 */
function continues(text: string, pos: number): boolean {
  const c = text[pos];
  return c === '(' || c === '[' || c === '.' || c === '{';
}

/**
 * Whether the character at `pos` ends the code expression.
 *
 * Inside brackets, nothing does — arguments span lines freely. At depth zero a
 * statement runs to the end of its line (`#set text(size: 10pt)` is over at the
 * newline, not at the space after `set`), while a plain expression ends at the
 * first whitespace, which is where `#name` hands the rest of the line back to
 * markup.
 */
function expressionEnds(text: string, pos: number, frame: Frame): boolean {
  if (frame.depth > 0) return false;
  const c = text[pos];
  if (c === '\n') return true;
  if (frame.statement) return false;
  return c === ' ' || c === '\t' || c === '\r';
}

function lineEnd(text: string, from: number): number {
  const nl = text.indexOf('\n', from);
  return nl === -1 ? text.length : nl;
}

/** End of a block comment, which nests in Typst. */
function blockCommentEnd(text: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    if (text.startsWith('/*', i)) {
      depth++;
      i += 2;
      continue;
    }
    if (text.startsWith('*/', i)) {
      depth--;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return text.length;
}

/**
 * End of a raw block, past its closing backtick run.
 *
 * The opening run's length is the delimiter: a ``` block may contain single
 * backticks, and an unterminated one runs to the end of the document rather
 * than swallowing the next backtick it happens to find.
 */
function rawEnd(text: string, from: number): number {
  let open = 0;
  while (text[from + open] === '`') open++;

  let i = from + open;
  while (i < text.length) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    let run = 0;
    while (text[i + run] === '`') run++;
    if (run >= open) return i + open;
    i += run;
  }
  return text.length;
}

/** End of a `$ ... $` math block, past the closing dollar. */
function mathEnd(text: string, from: number): number {
  let i = from + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '$') return i + 1;
    i++;
  }
  return text.length;
}

/** End of a `" ... "` string literal, past the closing quote. */
function stringEnd(text: string, from: number): number {
  let i = from + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '"') return i + 1;
    i++;
  }
  return text.length;
}
