/**
 * Text diagnostics — the app's own spelling / grammar / style pipeline.
 *
 * One model, one bus, one set of squiggles, fed by pluggable providers:
 * the built-in dictionary checker, the LanguageTool plugin, anything a
 * plugin contributes. This replaces the webview's native spellcheck,
 * which differed per platform and whose suggestion menu was unreachable
 * in PROD builds anyway (the root layout suppresses the native context
 * menu).
 *
 * Everything here is surface-agnostic and free of Svelte runes. The
 * ProseMirror and CodeMirror integrations live with the other editor
 * plugins and consume this; see `$lib/editor/plugins`.
 */

export type {
  CheckRequest,
  Diagnostic,
  DiagnosticKind,
  DiagnosticProvider,
  Segment,
  TextRange
} from './types';

export {
  DiagnosticBus,
  isAbortError,
  resolveOverlaps,
  type CheckOptions
} from './bus';

export {
  ADDRESS_PATTERNS,
  excludeIgnored,
  ignoreRanges,
  mergeRanges,
  overlapsAny,
  patternRanges
} from './ignore-ranges';

export {
  diagnosticSyntax,
  isDiagnosticSyntaxId,
  markdownSyntax,
  plainSyntax,
  splitParagraphs,
  typstSyntax,
  DIAGNOSTIC_SYNTAX_IDS,
  type DiagnosticSyntax,
  type DiagnosticSyntaxId
} from './syntax';

export { tokenizeWords, type Token } from './tokenize';
