import { describe, expect, it } from 'vitest';
import { typstIgnoreRanges } from './typst';
import { maskRanges } from '../ignore-ranges';

/**
 * Asserted through the mask rather than through raw offsets: the ranges only
 * ever exist to blank text out, and a masked document shows at a glance what
 * survives as prose. Offsets are preserved by masking, so this also proves the
 * ranges line up with the document the squiggles are drawn on.
 */
const prose = (text: string) => maskRanges(text, typstIgnoreRanges(text));

/** The words a checker would actually be handed. */
const words = (text: string) =>
  prose(text)
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w));

describe('typstIgnoreRanges', () => {
  it('keeps plain markup', () => {
    expect(prose('= Heading\n\nSome ordinary prose.')).toBe(
      '= Heading\n\nSome ordinary prose.'
    );
  });

  it('preserves offsets so squiggles land on the right words', () => {
    const text = '#set text(lang: "de")\nreal prose';
    expect(prose(text)).toHaveLength(text.length);
    expect(prose(text).indexOf('real')).toBe(text.indexOf('real'));
  });

  it('drops a set rule entirely, including its arguments', () => {
    // The false-positive flood this whole module exists to stop: every one of
    // `set`, `text`, `lang`, `justify` is a dictionary miss.
    expect(words('#set text(lang: "de", justify: true)\nHallo Welt')).toEqual([
      'Hallo',
      'Welt'
    ]);
  });

  it('drops imports and their package specs', () => {
    expect(words('#import "@preview/cetz:0.2.2": canvas\n\nDiagram below.')) //
      .toEqual(['Diagram', 'below.']);
  });

  it('checks the content block of a function call but not the call', () => {
    expect(words('#emph[a lovely phrase] and more')).toEqual([
      'a',
      'lovely',
      'phrase',
      'and',
      'more'
    ]);
  });

  it('checks named content arguments nested inside code', () => {
    const text = '#figure(caption: [The sample rate], image("plot.png"))';
    expect(words(text)).toEqual(['The', 'sample', 'rate']);
  });

  it('returns to markup after a call ends', () => {
    expect(words('Text #strong[bold] tail')).toEqual(['Text', 'bold', 'tail']);
  });

  it('keeps a chained call in code mode', () => {
    expect(words('#calc.max(1, 2) after')).toEqual(['after']);
  });

  it('runs a let binding to the end of its line', () => {
    expect(words('#let total = calc.sum(values)\nParagraph text')).toEqual([
      'Paragraph',
      'text'
    ]);
  });

  it('checks content bound by a let', () => {
    expect(words('#let intro = [Welcome aboard]\n')).toEqual([
      'Welcome',
      'aboard'
    ]);
  });

  it('checks both branches of a show rule body', () => {
    const text = '#show heading: it => [ Prefix #it.body ]\nAfterwards';
    expect(words(text)).toEqual(['Prefix', 'Afterwards']);
  });

  it('skips comments in both modes', () => {
    expect(words('Kept // dropped words here\nAlso kept')).toEqual([
      'Kept',
      'Also',
      'kept'
    ]);
    expect(words('Kept /* dropped */ again')).toEqual(['Kept', 'again']);
  });

  it('skips nested block comments as one unit', () => {
    expect(words('a /* one /* two */ still comment */ b')).toEqual(['a', 'b']);
  });

  it('skips raw blocks, honouring the opening fence length', () => {
    const text = 'Before\n```rust\nlet mut x = idx;\n```\nAfter';
    expect(words(text)).toEqual(['Before', 'After']);
  });

  it('skips inline raw containing backtick-free code', () => {
    expect(words('Call `retval` now')).toEqual(['Call', 'now']);
  });

  it('skips math', () => {
    expect(words('Where $x_i = alpha$ holds')).toEqual(['Where', 'holds']);
  });

  it('skips labels and references', () => {
    expect(words('See @knuth1984 in section <intro> below')).toEqual([
      'See',
      'in',
      'section',
      'below'
    ]);
  });

  it('skips URLs left as bare markup text', () => {
    expect(words('Docs at https://typst.app/docs today')).toEqual([
      'Docs',
      'at',
      'today'
    ]);
  });

  it('treats an escaped hash as literal text', () => {
    // The escape stays in the text — it is the document's to remove, not the
    // checker's. What matters is that `hashtag` reaches the dictionary.
    expect(words('A \\#hashtag stays')).toEqual(['A', '\\#hashtag', 'stays']);
  });

  it('treats a hash that opens nothing as literal text', () => {
    expect(words('Issue # numbering')).toEqual(['Issue', 'numbering']);
  });

  it('does not lose the tail of a document that ends mid-expression', () => {
    // Half-typed code is the steady state while writing, so it must not take
    // the rest of the document with it.
    expect(words('Intro paragraph\n\n#figure(')).toEqual([
      'Intro',
      'paragraph'
    ]);
  });

  it('survives stray closers without losing its mode', () => {
    expect(words('unbalanced ) and ] here')).toEqual([
      'unbalanced',
      'and',
      'here'
    ]);
  });

  it('handles a realistic document preamble', () => {
    const text = [
      '#set document(title: "Quarterly report")',
      '#set page(margin: 2cm, numbering: "1")',
      '#set text(font: "Libertinus Serif", size: 11pt)',
      '#show raw: set text(font: "Fira Code")',
      '',
      '= Quarterly report',
      '',
      'Revenue grew steadily across every region.',
      '',
      '#figure(',
      '  image("chart.png"),',
      '  caption: [Revenue by region],',
      ') <revenue>',
      '',
      'See @revenue for the breakdown.'
    ].join('\n');

    expect(words(text)).toEqual([
      'Quarterly',
      'report',
      'Revenue',
      'grew',
      'steadily',
      'across',
      'every',
      'region.',
      'Revenue',
      'by',
      'region',
      'See',
      'for',
      'the',
      'breakdown.'
    ]);
  });

  it('produces sorted, non-overlapping ranges', () => {
    const ranges = typstIgnoreRanges(
      '#set text(lang: "de") // note\n$x$ `raw` @ref <lab> #emph[ok]'
    );
    for (const [i, range] of ranges.entries()) {
      expect(range.from).toBeLessThan(range.to);
      if (i > 0) expect(range.from).toBeGreaterThan(ranges[i - 1].to);
    }
  });

  it('returns nothing for text with no code at all', () => {
    expect(typstIgnoreRanges('Just words, nothing else.')).toEqual([]);
  });
});

/**
 * Half-written constructs, which is what a document looks like for most of the
 * time it is being typed. Each one runs to the end of the document rather than
 * swallowing the next delimiter it happens to find, so the text after the
 * cursor stops being checked but never gets mis-attributed.
 */
describe('typstIgnoreRanges — unterminated constructs', () => {
  it('runs an unclosed block comment to the end of the document', () => {
    expect(words('Vor /* ein Kommentar\nzweite Zeile Text')).toEqual(['Vor']);
  });

  it('closes a block comment only at its matching depth', () => {
    expect(words('Vor /* a /* b */ c */ nach')).toEqual(['Vor', 'nach']);
  });

  it('runs an unclosed raw block to the end of the document', () => {
    expect(words('Vor ```rust\nfn main() {}\nunbeendet')).toEqual(['Vor']);
  });

  it('runs unclosed math to the end of the document', () => {
    expect(words('Vor $ x^2 unbeendet')).toEqual(['Vor']);
  });

  it('runs an unclosed string to the end of the document', () => {
    expect(words('#let s = "unbeendet')).toEqual([]);
  });

  it('does not let an escaped dollar close math', () => {
    expect(words('Vor $ x^2 + \\$ y $ nach')).toEqual(['Vor', 'nach']);
  });

  it('does not let an escaped quote close a string', () => {
    expect(words('#link("https://a.test/\\"x")[Klick] danach')).toEqual([
      'Klick',
      'danach'
    ]);
  });
});

describe('typstIgnoreRanges — bracket balance', () => {
  it('keeps prose inside a bracket nested in a content block', () => {
    expect(words('#emph[Inner [nested] bracket] danach')).toEqual([
      'Inner',
      '[nested]',
      'bracket',
      'danach'
    ]);
  });

  it('treats a stray closing bracket in markup as literal text', () => {
    expect(prose('Text mit ] allein danach')).toBe('Text mit ] allein danach');
  });

  it('leaves a bare hash before a space as typed text', () => {
    expect(words('Ein #bare hash')).toEqual(['Ein', 'hash']);
  });
});

describe('typstIgnoreRanges — code that does not balance', () => {
  it('drops a parenthesised or braced expression opened with a bare hash', () => {
    expect(words('#(1 + 2) danach')).toEqual(['danach']);
    expect(words('#{ let x = 1 } danach')).toEqual(['danach']);
  });

  it('hands a closing bracket back when the code frame never opened it', () => {
    // The stray `)` and `]` are markup the user typed, so they stay put and
    // the prose after them is still checked.
    expect(prose('Vor #f(1)) danach')).toBe('Vor      ) danach');
    expect(prose('Vor #let x = ] danach')).toBe('Vor          ] danach');
  });

  it('keeps a short backtick run inside a longer raw block', () => {
    // The opening run is the delimiter: a ``` block may contain single
    // backticks without ending early.
    expect(words('``` code ` tick ``` danach')).toEqual(['danach']);
  });
});
