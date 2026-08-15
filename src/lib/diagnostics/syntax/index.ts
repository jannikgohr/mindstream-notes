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
 * Add the line-structure whitespace every source syntax shares.
 *
 * Composed here rather than repeated in each syntax because indentation is not
 * a fact about Markdown or Typst — it is a fact about text that has lines, and
 * a syntax that forgot it would quietly reintroduce a doubled-space complaint
 * on every indented line. See `lineIndentRanges` for why this is positional and
 * not a match on the checker's message.
 */
function withLineStructure(
  ignore: (text: string) => TextRange[]
): (text: string) => TextRange[] {
  return (text) => mergeRanges([...ignore(text), ...lineIndentRanges(text)]);
}

/** Markdown notes — the app's own, and the behaviour every surface had first. */
export const markdownSyntax: DiagnosticSyntax = {
  id: 'markdown',
  ignoreRanges: withLineStructure(ignoreRanges),
  segment: splitParagraphs
};

/**
 * Text with no syntax at all: a Kanban card description, a form field.
 *
 * Not "ignore nothing" — a user pastes links into a description like anywhere
 * else, and a URL checked word by word is the noisiest thing a dictionary can
 * do. But nothing beyond that: a `#` here is a hash and a `*` is an asterisk,
 * and pretending otherwise would silently skip prose the user can see.
 */
export const plainSyntax: DiagnosticSyntax = {
  id: 'plain',
  ignoreRanges: withLineStructure((text) =>
    patternRanges(text, ADDRESS_PATTERNS)
  ),
  segment: splitParagraphs
};

/** Typst documents — see `./typst.ts` for why this needs a real scanner. */
export const typstSyntax: DiagnosticSyntax = {
  id: 'typst',
  ignoreRanges: withLineStructure(typstIgnoreRanges),
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
