import type { Extension } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { StreamLanguage } from '@codemirror/language';
import { pluginSourceLanguage } from '$lib/plugins/registry.svelte';
import type { PluginSourceLanguageHostProvider } from '$lib/plugins/types';

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
