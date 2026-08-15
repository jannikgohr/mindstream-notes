import { describe, expect, it } from 'vitest';
import {
  diagnosticSyntax,
  isDiagnosticSyntaxId,
  markdownSyntax,
  plainSyntax,
  typstSyntax,
  DIAGNOSTIC_SYNTAX_IDS
} from './index';
import { maskRanges } from '../ignore-ranges';

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
  const prose = (text: string) =>
    maskRanges(text, plainSyntax.ignoreRanges(text));

  it('checks everything that is not an address', () => {
    expect(prose('Ship the #v2 milestone *soon*')).toBe(
      'Ship the #v2 milestone *soon*'
    );
  });

  it('skips URLs and emails', () => {
    const text = 'Spec at https://example.com/a — ask ana@example.com';
    const masked = prose(text);
    expect(masked).toHaveLength(text.length);
    expect(masked).not.toContain('example.com');
    expect(masked).toContain('Spec at');
    expect(masked).toContain('ask');
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
