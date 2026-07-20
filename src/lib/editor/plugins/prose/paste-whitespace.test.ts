import { describe, expect, it } from 'vitest';
import { stripInterBlockWhitespace } from './paste-whitespace';

/** Text content of every paragraph the HTML would parse into. */
function paragraphs(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.body.querySelectorAll('p')].map((p) => p.textContent ?? '');
}

describe('stripInterBlockWhitespace', () => {
  it('drops a newline between two block elements', () => {
    const out = stripInterBlockWhitespace(
      '<p data-pm-slice="1 1 []">alpha</p>\n<p>beta</p>'
    );
    expect(out).toBe('<p data-pm-slice="1 1 []">alpha</p><p>beta</p>');
  });

  it('drops the indentation a CF_HTML wrapper leaves around the fragment', () => {
    const out = stripInterBlockWhitespace(
      '<p>alpha</p>\r\n  <p>beta</p>\r\n  <p>gamma</p>'
    );
    expect(paragraphs(out)).toEqual(['alpha', 'beta', 'gamma']);
    expect(out).not.toMatch(/>\s+</);
  });

  it('keeps the slice metadata that makes ProseMirror reuse the copied slice', () => {
    const out = stripInterBlockWhitespace(
      '<p data-pm-slice="1 1 []">alpha</p>\n<p>beta</p>'
    );
    expect(out).toContain('data-pm-slice="1 1 []"');
  });

  it('keeps a real space between two inline elements', () => {
    const html = '<p><em>a</em> <em>b</em></p>';
    expect(stripInterBlockWhitespace(html)).toBe(html);
  });

  it('keeps whitespace inside pre/code', () => {
    const html = '<pre><code>a\n  b\n</code></pre>';
    expect(stripInterBlockWhitespace(html)).toBe(html);
  });

  it('leaves already-clean clipboard HTML byte-identical', () => {
    const html = '<h1 data-pm-slice="0 0 []">t</h1><p>alpha</p><p>beta</p>';
    expect(stripInterBlockWhitespace(html)).toBe(html);
  });

  it('keeps text that only looks like whitespace padding', () => {
    const html = '<p>alpha </p>';
    expect(stripInterBlockWhitespace(html)).toBe(html);
  });

  it('handles empty input', () => {
    expect(stripInterBlockWhitespace('')).toBe('');
  });
});
