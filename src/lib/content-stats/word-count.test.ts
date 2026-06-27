import { describe, expect, it } from 'vitest';
import { countWords, markdownToPlain } from './word-count';

describe('word-count (TS mirror of content_stats.rs)', () => {
  it('counts plain words including internal connectors', () => {
    expect(countWords('hello world')).toBe(2);
    expect(countWords("don't well-known foo_bar")).toBe(3);
    expect(countWords('   ')).toBe(0);
  });

  it('strips markdown noise before counting', () => {
    const md =
      '# Title\n\n**bold** word ![alt](img.png) [label](http://x) `code`';
    // Title, bold, word, label (alt/img/url/code excluded).
    expect(countWords(markdownToPlain(md))).toBe(4);
  });

  it('excludes fenced code', () => {
    expect(
      countWords(markdownToPlain('intro\n```\nlet x = 1;\n```\noutro'))
    ).toBe(2);
  });

  it('does not count HTML tags or comments as words', () => {
    expect(countWords(markdownToPlain('line one<br />line two'))).toBe(4);
    expect(
      countWords(
        markdownToPlain('<div class="x">hello</div> <!-- note --> world')
      )
    ).toBe(2);
    expect(countWords(markdownToPlain('if a < b then'))).toBe(4);
  });
});
