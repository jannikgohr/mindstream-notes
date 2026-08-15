import { afterEach, describe, expect, it } from 'vitest';
import { StringStream } from '@codemirror/language';
import {
  registerPlugin,
  resetPluginRegistry,
  setPluginEnabled
} from '$lib/plugins/registry.svelte';
import {
  sourceLanguageDiagnosticSyntax,
  sourceLanguageExtensions
} from './languages';

interface StreamParserLike {
  startState: () => unknown;
  token: (stream: StringStream, state: unknown) => string | null;
}

/** Run the plugin-provided Typst StreamLanguage tokenizer over `src`. */
function tokenizeTypst(
  src: string
): Array<{ text: string; tag: string | null }> {
  const ext = sourceLanguageExtensions('typst');
  const parser = (ext[0] as unknown as { streamParser: StreamParserLike })
    .streamParser;
  const state = parser.startState();
  const out: Array<{ text: string; tag: string | null }> = [];
  for (const line of src.split('\n')) {
    if (line === '') continue;
    const stream = new StringStream(line, 2, 2);
    let guard = 0;
    while (!stream.eol()) {
      const start = stream.pos;
      const tag = parser.token(stream, state);
      if (stream.pos === start) stream.next();
      out.push({ text: stream.string.slice(start, stream.pos), tag });
      if (++guard > 2000) break;
    }
  }
  return out;
}

function typstLanguageManifest(
  diagnostics?: Record<string, unknown>
): Record<string, unknown> {
  return {
    id: 'com.example.typst',
    name: 'Typst',
    version: '1.0.0',
    runtime: 'manifest-only',
    permissions: [],
    contributes: {
      sourceLanguages: [
        {
          id: 'typst',
          aliases: ['typ'],
          extensions: ['typ'],
          provider: { type: 'host', id: 'typst' },
          ...(diagnostics ? { diagnostics } : {})
        }
      ]
    }
  };
}

afterEach(() => resetPluginRegistry());

describe('sourceLanguageExtensions', () => {
  it('always provides built-in markdown support', () => {
    expect(sourceLanguageExtensions('markdown')).not.toHaveLength(0);
  });

  it('keeps plugin languages plain text until an enabled plugin contributes them', () => {
    expect(sourceLanguageExtensions('typst')).toHaveLength(0);
    registerPlugin(typstLanguageManifest());
    expect(sourceLanguageExtensions('typst')).not.toHaveLength(0);
    expect(sourceLanguageExtensions('typ')).not.toHaveLength(0);
  });

  it('removes plugin language support when the owning plugin is disabled', () => {
    registerPlugin(typstLanguageManifest());
    setPluginEnabled('com.example.typst', false);
    expect(sourceLanguageExtensions('typst')).toHaveLength(0);
  });
});

describe('sourceLanguageDiagnosticSyntax', () => {
  it('checks built-in markdown as markdown', () => {
    expect(sourceLanguageDiagnosticSyntax('markdown')?.id).toBe('markdown');
  });

  it('leaves a plugin language unchecked until its manifest opts in', () => {
    // Not a fallback to plain text: a language nobody has called prose gets no
    // squiggles at all, so enabling a plugin can never speckle a document the
    // app does not know how to read.
    registerPlugin(typstLanguageManifest());
    expect(sourceLanguageDiagnosticSyntax('typst')).toBeNull();
  });

  it('uses the host syntax the manifest names, through aliases too', () => {
    registerPlugin(typstLanguageManifest({ syntax: 'typst' }));
    expect(sourceLanguageDiagnosticSyntax('typst')?.id).toBe('typst');
    expect(sourceLanguageDiagnosticSyntax('typ')?.id).toBe('typst');
  });

  it('stops checking when the owning plugin is disabled', () => {
    registerPlugin(typstLanguageManifest({ syntax: 'typst' }));
    setPluginEnabled('com.example.typst', false);
    expect(sourceLanguageDiagnosticSyntax('typst')).toBeNull();
  });

  it('leaves an unknown language unchecked', () => {
    expect(sourceLanguageDiagnosticSyntax('text')).toBeNull();
  });
});

describe('Typst tokenizer', () => {
  it('assigns highlight tags across the full token grammar', () => {
    registerPlugin(typstLanguageManifest());
    const src = [
      '= Heading one',
      '#{1} deep', // '#' heading form at start of line
      '#let x = 1pt',
      '#myVar and plain',
      '// a line comment',
      '"a \\"quoted\\" string" `inline code` $x^2$ @ref <lbl.a>',
      'call(1, 2.5cm) + - * / . , ; strong *_',
      '™ falls through'
    ].join('\n');
    const tags = new Set(tokenizeTypst(src).map((t) => t.tag));
    for (const expected of [
      'heading',
      'keyword',
      'variable-2',
      'variable',
      'comment',
      'string',
      'string-2',
      'atom',
      'link',
      'def',
      'number',
      'operator',
      'punctuation',
      'strong'
    ]) {
      expect(tags.has(expected), `expected a ${expected} token`).toBe(true);
    }
    // Unrecognised glyphs advance one char with a null tag.
    expect(tokenizeTypst('™').some((t) => t.tag === null)).toBe(true);
  });

  it('tracks nested and multi-line block comments', () => {
    registerPlugin(typstLanguageManifest());
    // Single-line nested comment closes fully on the same line.
    const single = tokenizeTypst('/* outer /* inner */ still */ x');
    expect(single[0].tag).toBe('comment');
    expect(single.some((t) => t.tag === 'variable' && t.text === 'x')).toBe(
      true
    );

    // A comment left open carries across lines until its close.
    const multi = tokenizeTypst(
      ['/* start', 'middle line', 'end */ done'].join('\n')
    );
    expect(multi.filter((t) => t.tag === 'comment').length).toBeGreaterThan(0);
    expect(multi.some((t) => t.tag === 'variable' && t.text === 'done')).toBe(
      true
    );
  });
});
