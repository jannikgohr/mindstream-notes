import type { Extension } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { StreamLanguage } from '@codemirror/language';
import {
  pluginSourceLanguage,
  recordPluginLoadError
} from '$lib/plugins/registry.svelte';
import type { PluginSourceLanguageHostProvider } from '$lib/plugins/types';
import {
  createGrammarSyntax,
  diagnosticSyntax,
  markdownSyntax,
  type DiagnosticSyntax
} from '$lib/diagnostics/syntax';

interface SourceLanguageProvider {
  id: PluginSourceLanguageHostProvider | 'markdown';
  extensions: () => Extension[];
}

interface TypstState {
  blockCommentDepth: number;
}

interface TypstStream {
  eol(): boolean;
  match(
    pattern: string | RegExp,
    consume?: boolean,
    caseInsensitive?: boolean
  ): boolean | RegExpMatchArray | null;
  next(): string | void;
}

const typst = StreamLanguage.define<TypstState>({
  name: 'typst',
  startState: () => ({ blockCommentDepth: 0 }),
  token(stream, state) {
    if (state.blockCommentDepth > 0) return tokenBlockComment(stream, state);

    if (stream.eatSpace()) return null;

    if (stream.sol()) {
      if (stream.match(/={1,6}(?=\s)/)) return 'heading';
      if (stream.match(/#{1,6}(?=\s)/)) return 'heading';
    }

    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('/*')) {
      state.blockCommentDepth = 1;
      return tokenBlockComment(stream, state);
    }

    if (stream.match(/"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/`[^`]*`?/)) return 'string-2';
    if (stream.match(/\$[^$]*\$?/)) return 'atom';
    if (stream.match(/@[A-Za-z_][A-Za-z0-9_-]*/)) return 'link';
    if (stream.match(/<[A-Za-z_][A-Za-z0-9_.:-]*>/)) return 'def';
    if (stream.match(/\b\d+(?:\.\d+)?(?:pt|mm|cm|in|em|fr|%|deg)?\b/)) {
      return 'number';
    }

    if (stream.match('#')) {
      if (
        stream.match(
          /(?:let|set|show|import|include|if|else|for|in|while|break|continue|return|context|locate|assert|panic)\b/
        )
      ) {
        return 'keyword';
      }
      if (stream.match(/[A-Za-z_][A-Za-z0-9_-]*/)) return 'variable-2';
      return 'meta';
    }

    if (stream.match(/[A-Za-z_][A-Za-z0-9_-]*(?=\s*\()/)) {
      return 'variable-2';
    }
    if (stream.match(/[A-Za-z_][A-Za-z0-9_-]*/)) return 'variable';
    if (stream.match(/[*_]{1,2}/)) return 'strong';
    if (stream.match(/[+\-*/=<>!?:|&]+/)) return 'operator';
    if (stream.match(/[()[\]{}.,;]/)) return 'punctuation';

    stream.next();
    return null;
  },
  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } }
  }
});

function tokenBlockComment(stream: TypstStream, state: TypstState): string {
  while (!stream.eol()) {
    if (stream.match('/*')) {
      state.blockCommentDepth++;
      continue;
    }
    if (stream.match('*/')) {
      state.blockCommentDepth--;
      if (state.blockCommentDepth <= 0) break;
      continue;
    }
    stream.next();
  }
  return 'comment';
}

const HOST_LANGUAGE_PROVIDERS: Record<
  PluginSourceLanguageHostProvider,
  SourceLanguageProvider
> = {
  typst: {
    id: 'typst',
    extensions: () => [typst]
  }
};

const BUILT_IN_LANGUAGE_PROVIDERS: Record<string, SourceLanguageProvider> = {
  markdown: {
    id: 'markdown',
    extensions: () => [markdown()]
  }
};

export function sourceLanguageExtensions(language: string): Extension[] {
  const builtIn = BUILT_IN_LANGUAGE_PROVIDERS[language];
  if (builtIn) return builtIn.extensions();

  const pluginLanguage = pluginSourceLanguage(language);
  if (!pluginLanguage) return [];
  return HOST_LANGUAGE_PROVIDERS[
    pluginLanguage.language.provider.id
  ].extensions();
}

/**
 * How to find the prose in this language, or `null` for "do not check it".
 *
 * The counterpart to `sourceLanguageExtensions`, resolved the same way and
 * from the same id, so one language cannot end up highlighted as Typst and
 * spellchecked as Markdown. Built-in Markdown is always checked; a plugin
 * language is checked only where its manifest opted in, which is why the
 * return type admits null rather than falling back to plain text — silence is
 * the correct answer for a language nobody has said is prose.
 */
export function sourceLanguageDiagnosticSyntax(
  language: string
): DiagnosticSyntax | null {
  if (BUILT_IN_LANGUAGE_PROVIDERS[language]) return markdownSyntax;

  // A manifest opts in either by naming a syntax the app ships or by declaring
  // a grammar of its own; validation has already established it is exactly one.
  const ref = pluginSourceLanguage(language);
  const diagnostics = ref?.language.diagnostics;
  if (!ref || !diagnostics) return null;
  if (diagnostics.grammar) {
    // A grammar whose patterns are stopped keeps working on its delimiters, so
    // nothing breaks loudly on its own — which is exactly why it has to be
    // reported. The plugin panel already shows this field, and an unexplained
    // drop in squiggles is otherwise indistinguishable from a clean document.
    return createGrammarSyntax(diagnostics.grammar, (reason) =>
      recordPluginLoadError(ref.pluginId, reason)
    );
  }
  return diagnostics.syntax ? diagnosticSyntax(diagnostics.syntax) : null;
}
