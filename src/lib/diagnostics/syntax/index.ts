/**
 * The syntaxes the app knows how to find prose in.
 *
 * A registry rather than a switch in the CodeMirror surface, because two very
 * different callers need to resolve one by id: the source editor, which is
 * handed a language id by whatever note it is showing, and the plugin layer,
 * where a manifest names a syntax it wants its note kind checked with. Both
 * ask here, so both get the same answer and neither can name a syntax that
 * does not exist.
 */

import {
  ADDRESS_PATTERNS,
  ignoreRanges,
  lineIndentRanges,
  mergeRanges,
  patternRanges
} from '../ignore-ranges';
import type { TextRange } from '../types';
import { splitParagraphs } from './segment';
import { typstIgnoreRanges } from './typst';
import type { DiagnosticSyntax, DiagnosticSyntaxId } from './types';

/**
 * Also ignore each line's leading whitespace.
 *
 * Opt-in per syntax, NOT a property of text that happens to have lines. It
 * belongs to a language where indentation is syntax — in Markdown it nests a
 * list item, in Typst it sits inside a block — so a checker complaining about
 * the doubled space is commenting on the document's structure rather than on
 * anything the author wrote. Where indentation carries no meaning, leading
 * spaces are just spaces the user typed, and skipping them would hide exactly
 * the typo the rule is there to catch. See `lineIndentRanges` for why the
 * filtering is positional rather than a match on the checker's message.
 */
function withIndentation(
  ignore: (text: string) => TextRange[]
): (text: string) => TextRange[] {
  return (text) => mergeRanges([...ignore(text), ...lineIndentRanges(text)]);
}

/** Markdown notes — the app's own, and the behaviour every surface had first. */
export const markdownSyntax: DiagnosticSyntax = {
  id: 'markdown',
  ignoreRanges: withIndentation(ignoreRanges),
  segment: splitParagraphs
};

/**
 * Text with no syntax at all: a Kanban card description, a form field.
 *
 * Not "ignore nothing" — a user pastes links into a description like anywhere
 * else, and a URL checked word by word is the noisiest thing a dictionary can
 * do. But nothing beyond that: a `#` here is a hash and a `*` is an asterisk,
 * and pretending otherwise would silently skip prose the user can see.
 *
 * Indentation included, which is why this does NOT take `withIndentation`.
 * Leading spaces are only structure in a language that gives them meaning;
 * here they are text, and a doubled space is as much a typo at the start of a
 * line as in the middle of one.
 */
export const plainSyntax: DiagnosticSyntax = {
  id: 'plain',
  ignoreRanges: (text) => mergeRanges(patternRanges(text, ADDRESS_PATTERNS)),
  segment: splitParagraphs
};

/** Typst documents — see `./typst.ts` for why this needs a real scanner. */
export const typstSyntax: DiagnosticSyntax = {
  id: 'typst',
  ignoreRanges: withIndentation(typstIgnoreRanges),
  segment: splitParagraphs
};

const SYNTAXES: Record<DiagnosticSyntaxId, DiagnosticSyntax> = {
  markdown: markdownSyntax,
  plain: plainSyntax,
  typst: typstSyntax
};

/** Resolve a syntax by id. Unknown ids fall back to plain text. */
export function diagnosticSyntax(
  id: string | null | undefined
): DiagnosticSyntax {
  return SYNTAXES[id as DiagnosticSyntaxId] ?? plainSyntax;
}

/** True for an id the app actually ships — used to validate manifests. */
export function isDiagnosticSyntaxId(id: unknown): id is DiagnosticSyntaxId {
  return typeof id === 'string' && id in SYNTAXES;
}

export { splitParagraphs } from './segment';
export { typstIgnoreRanges } from './typst';
export {
  DIAGNOSTIC_SYNTAX_IDS,
  type DiagnosticSyntax,
  type DiagnosticSyntaxId
} from './types';

export {
  compilePattern,
  createGrammarSyntax,
  grammarIgnoreRanges,
  type DelimiterPair,
  type DiagnosticGrammar
} from './grammar';

export {
  grammarFaulted,
  resetGrammarRunner,
  runGrammar
} from './grammar-runner';
