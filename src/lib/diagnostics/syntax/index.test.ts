import { describe, expect, it } from 'vitest';
import {
  diagnosticSyntax,
  isDiagnosticSyntaxId,
  markdownSyntax,
  plainSyntax,
  typstSyntax,
  DIAGNOSTIC_SYNTAX_IDS
} from './index';
import { excludeIgnored, maskRanges } from '../ignore-ranges';

describe('diagnosticSyntax', () => {
  it('resolves every id it advertises', () => {
    for (const id of DIAGNOSTIC_SYNTAX_IDS) {
      expect(diagnosticSyntax(id).id).toBe(id);
    }
  });

  it('falls back to plain text for an id it does not know', () => {
    // Reached only through code paths that already validated the id, so the
    // fallback is a belt-and-braces default rather than a decision: plain is
    // the one syntax that cannot mis-skip prose.
    expect(diagnosticSyntax('latex')).toBe(plainSyntax);
    expect(diagnosticSyntax(null)).toBe(plainSyntax);
  });

  it('recognizes exactly the ids it ships', () => {
    expect(isDiagnosticSyntaxId('typst')).toBe(true);
    expect(isDiagnosticSyntaxId('latex')).toBe(false);
    expect(isDiagnosticSyntaxId(undefined)).toBe(false);
  });
});

describe('plainSyntax', () => {
  const prose = async (text: string) =>
    maskRanges(text, await plainSyntax.ignoreRanges(text));

  it('checks everything that is not an address', async () => {
    expect(await prose('Ship the #v2 milestone *soon*')).toBe(
      'Ship the #v2 milestone *soon*'
    );
  });

  it('skips URLs and emails', async () => {
    const text = 'Spec at https://example.com/a — ask ana@example.com';
    const masked = await prose(text);
    expect(masked).toHaveLength(text.length);
    expect(masked).not.toContain('example.com');
    expect(masked).toContain('Spec at');
    expect(masked).toContain('ask');
  });
});

describe('line indentation', () => {
  /**
   * A doubled-space complaint on an indented line, as LanguageTool reports it.
   * The message is German on purpose: the whole point of filtering by position
   * is that nothing downstream reads it.
   */
  const doubledSpace = (from: number, to: number) => ({
    from,
    to,
    kind: 'style' as const,
    message: 'Möglicher Tippfehler: mehr als ein Leerzeichen hintereinander',
    replacements: [' '],
    source: 'languagetool'
  });

  const indented = ['Intro line', '    indented continuation'].join('\n');

  it('drops an indentation complaint where indentation is syntax', async () => {
    const indent = indented.indexOf('    ');
    for (const syntax of [markdownSyntax, typstSyntax]) {
      const ignored = await syntax.ignoreRanges(indented);
      expect(
        excludeIgnored([doubledSpace(indent, indent + 4)], ignored)
      ).toEqual([]);
    }
  });

  it('keeps it in plain text, where leading spaces mean nothing', async () => {
    // A card description has no nesting to express, so a run of spaces at the
    // start of a line is the same typo it would be anywhere else. Exempting it
    // here would hide the very thing the rule catches.
    const indent = indented.indexOf('    ');
    const flagged = doubledSpace(indent, indent + 4);
    expect(
      excludeIgnored([flagged], await plainSyntax.ignoreRanges(indented))
    ).toEqual([flagged]);
  });

  it('keeps a doubled space inside a sentence', async () => {
    // The rule is right there — only its verdict on indentation is wrong.
    const text = 'One  two';
    const kept = doubledSpace(3, 5);
    for (const syntax of [markdownSyntax, plainSyntax, typstSyntax]) {
      expect(excludeIgnored([kept], await syntax.ignoreRanges(text))).toEqual([
        kept
      ]);
    }
  });

  it('does not shift the offsets of anything after it', async () => {
    // Masking indentation replaces spaces with spaces, so a squiggle further
    // down the line still lands where the checker put it.
    const text = '  - a nested item';
    const masked = maskRanges(text, await markdownSyntax.ignoreRanges(text));
    expect(masked).toHaveLength(text.length);
    expect(masked.indexOf('nested')).toBe(text.indexOf('nested'));
  });

  it('covers a whitespace-only line whole', async () => {
    const text = ['a', '   ', 'b'].join('\n');
    expect(await markdownSyntax.ignoreRanges(text)).toContainEqual({
      from: 2,
      to: 5
    });
  });

  it('ignores a line that starts at column zero', async () => {
    expect(await plainSyntax.ignoreRanges('no indent here')).toEqual([]);
  });
});

describe('syntax segmentation', () => {
  it('is shared across syntaxes — paragraphs end at blank lines', () => {
    const text = 'One two\nthree\n\nFour five';
    for (const syntax of [markdownSyntax, plainSyntax, typstSyntax]) {
      expect(syntax.segment(text)).toEqual([
        { text: 'One two\nthree', from: 0, to: 13 },
        { text: 'Four five', from: 15, to: 24 }
      ]);
    }
  });
});
