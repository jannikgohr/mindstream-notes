/**
 * What a checking surface needs to know about the language it is holding.
 *
 * `ignore-ranges.ts` answers this for Markdown, and for a while Markdown was
 * the only answer any surface needed. It is not any more: a Typst document is
 * mostly code with prose in it, and a Kanban card description is prose with no
 * syntax at all. Checking either one with the Markdown rules produces exactly
 * the failure the ignore-ranges module exists to prevent — a `#set page(...)`
 * line comes back speckled with red, and the user concludes the feature is
 * broken.
 *
 * So the two questions the CodeMirror surface used to answer inline become an
 * interface, and the surface takes whichever implementation matches the note it
 * is showing. Both questions are about SOURCE TEXT; the WYSIWYG surface still
 * derives the same facts structurally from the ProseMirror document, which is a
 * better signal than re-parsing and always available there.
 *
 * HOST-OWNED ON PURPOSE. Plugins pick a syntax by id from the set the app
 * ships — the same rule the source-language providers already follow (see
 * `PluginSourceLanguageContribution`). A syntax runs on every keystroke of
 * every note in its language, so it is not somewhere a plugin bundle gets to
 * inject code.
 */

import type { Segment, TextRange } from '../types';

/** Ids of the syntaxes the app ships. Plugin manifests choose from these. */
export const DIAGNOSTIC_SYNTAX_IDS = ['markdown', 'plain', 'typst'] as const;

export type DiagnosticSyntaxId = (typeof DIAGNOSTIC_SYNTAX_IDS)[number];

export interface DiagnosticSyntax {
  id: DiagnosticSyntaxId;
  /**
   * Every range of `text` that is not prose, sorted and merged.
   *
   * Used twice by the caller and it matters that it is the same answer both
   * times: once to mask the text before a checker sees it, and once to drop
   * findings that landed in a masked region anyway.
   */
  ignoreRanges(text: string): TextRange[];
  /**
   * Cut `text` into the units handed to providers — in practice paragraphs.
   *
   * Called with the already-masked text, so an implementation may rely on
   * ignored regions having collapsed to blanks. Segmenting is what makes the
   * bus's cache useful: editing one paragraph re-checks one paragraph.
   */
  segment(text: string): Segment[];
}
