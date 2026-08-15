import { describe, expect, it } from 'vitest';
import {
  createGrammarSyntax,
  grammarIgnoreRanges,
  type DiagnosticGrammar
} from './grammar';
import { maskRanges } from '../ignore-ranges';

/**
 * A LaTeX-shaped grammar — the motivating case for letting a plugin describe a
 * language the app has no scanner for.
 */
const latex: DiagnosticGrammar = {
  lineComments: ['%'],
  verbatim: [
    ['\\begin{verbatim}', '\\end{verbatim}'],
    ['\\begin{lstlisting}', '\\end{lstlisting}']
  ],
  math: [
    ['$$', '$$'],
    ['$', '$'],
    ['\\[', '\\]']
  ],
  escape: '\\',
  indentation: true
};

const prose = (grammar: DiagnosticGrammar, text: string) =>
  maskRanges(text, grammarIgnoreRanges(grammar, text));

const words = (grammar: DiagnosticGrammar, text: string) =>
  prose(grammar, text)
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w));

describe('grammarIgnoreRanges', () => {
  it('keeps text a grammar says nothing about', () => {
    expect(prose(latex, 'An ordinary sentence.')).toBe('An ordinary sentence.');
  });

  it('preserves offsets', () => {
    const text = '% a comment\nreal prose';
    expect(prose(latex, text)).toHaveLength(text.length);
    expect(prose(latex, text).indexOf('real')).toBe(text.indexOf('real'));
  });

  it('skips a line comment to the end of its line only', () => {
    expect(words(latex, 'Kept % dropped entirely\nAlso kept')).toEqual([
      'Kept',
      'Also',
      'kept'
    ]);
  });

  it('skips a delimited verbatim block', () => {
    const text =
      'Before\n\\begin{verbatim}\nint idx = 0;\n\\end{verbatim}\nAfter';
    expect(words(latex, text)).toEqual(['Before', 'After']);
  });

  it('prefers the longest opener at a position', () => {
    // `$$` and `$` both start here; picking `$` would end the span at the
    // second dollar and leave the display maths as prose.
    expect(words(latex, 'Given $$alpha beta$$ we conclude')).toEqual([
      'Given',
      'we',
      'conclude'
    ]);
  });

  it('honours the escape so an escaped marker opens nothing', () => {
    expect(words(latex, 'A 50\\% share stays')).toEqual([
      'A',
      'share',
      'stays'
    ]);
  });

  it('runs an unterminated span to the end rather than guessing a closer', () => {
    // Half-typed markup is the steady state while writing; the alternative is
    // squiggles landing on text the user is still in the middle of.
    expect(words(latex, 'Intro\n\n\\begin{verbatim}\nstill typing')).toEqual([
      'Intro'
    ]);
  });

  it('ignores indentation only when the grammar asks for it', () => {
    const text = ['Line one', '    indented'].join('\n');
    expect(grammarIgnoreRanges(latex, text)).toContainEqual({
      from: text.indexOf('    '),
      to: text.indexOf('    ') + 4
    });
    expect(grammarIgnoreRanges({ ...latex, indentation: false }, text)).toEqual(
      []
    );
  });

  it('skips addresses by default and on request', () => {
    const text = 'Docs at https://example.com/a now';
    expect(words({}, text)).toEqual(['Docs', 'at', 'now']);
    expect(words({ addresses: false }, text)).toContain(
      'https://example.com/a'
    );
  });

  it('does not double-count an address inside a comment', () => {
    const ranges = grammarIgnoreRanges(latex, '% see https://example.com/a');
    expect(ranges).toEqual([{ from: 0, to: 27 }]);
  });

  it('produces sorted, non-overlapping ranges', () => {
    const ranges = grammarIgnoreRanges(
      latex,
      '  $x$ and % note\n\\begin{verbatim}v\\end{verbatim} end'
    );
    for (const [i, range] of ranges.entries()) {
      expect(range.from).toBeLessThan(range.to);
      if (i > 0) expect(range.from).toBeGreaterThan(ranges[i - 1].to);
    }
  });

  it('is inert for an empty grammar', () => {
    expect(grammarIgnoreRanges({}, 'Nothing here is special.')).toEqual([]);
  });

  it('tolerates a grammar whose delimiters never appear', () => {
    expect(prose(latex, 'Plain words only')).toBe('Plain words only');
  });
});

describe('createGrammarSyntax', () => {
  it('reuses the compiled syntax for the same grammar object', () => {
    // The registry hands out one frozen contribution per plugin, and the
    // editor re-resolves on every reconfiguration — recompiling each time
    // would rebuild the lookup tables for no reason.
    expect(createGrammarSyntax(latex)).toBe(createGrammarSyntax(latex));
  });

  it('reports itself as a grammar rather than a shipped syntax', () => {
    expect(createGrammarSyntax(latex).id).toBe('grammar');
  });

  it('segments into paragraphs like every other syntax', () => {
    expect(createGrammarSyntax(latex).segment('One\n\nTwo')).toEqual([
      { text: 'One', from: 0, to: 3 },
      { text: 'Two', from: 5, to: 8 }
    ]);
  });
});
