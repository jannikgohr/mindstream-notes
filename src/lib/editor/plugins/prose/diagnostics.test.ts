/**
 * Document analysis for the WYSIWYG diagnostics plugin, driven through a
 * real ProseMirror document.
 *
 * The contract under test is the one that decides whether a squiggle lands
 * on the right word: a segment's `from` must be the document position of
 * its first character, so a string offset within the segment text adds
 * directly to it with no translation step. Inline leaf nodes are the trap —
 * an image counts as one position but has no text, so anything that
 * flattens it to "" or to a multi-character placeholder silently shifts
 * every later word in the block.
 */

import { describe, expect, it } from 'vitest';
import { Schema, type Node as ProseNode } from '@milkdown/kit/prose/model';
import { analyzeDocument, diagnosticDecorations } from './diagnostics';
import type { Diagnostic } from '$lib/diagnostics/types';
import { noteHref } from '../wikilink-href';
import { userHref } from '../user-mention-href';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    heading: { group: 'block', content: 'inline*', toDOM: () => ['h1', 0] },
    code_block: {
      group: 'block',
      content: 'text*',
      code: true,
      marks: '',
      toDOM: () => ['pre', ['code', 0]]
    },
    image: { group: 'inline', inline: true, toDOM: () => ['img'] },
    text: { group: 'inline' }
  },
  marks: {
    code: { toDOM: () => ['code', 0] },
    link: {
      attrs: { href: {} },
      toDOM: (mark) => ['a', { href: mark.attrs.href as string }, 0]
    }
  }
});

const para = (...content: ProseNode[]) =>
  schema.node('paragraph', null, content);
const doc = (...blocks: ProseNode[]) => schema.node('doc', null, blocks);
const t = (text: string, marks: ProseNode['marks'] = []) =>
  schema.text(text, marks);

/** The document position each segment's text starts at, per the segment. */
function textAt(document: ProseNode, from: number, length: number): string {
  return document.textBetween(
    from,
    from + length,
    ' ',
    String.fromCharCode(0xfffc)
  );
}

describe('analyzeDocument', () => {
  it('produces one segment per textblock', () => {
    const d = doc(para(t('first para')), para(t('second para')));
    expect(analyzeDocument(d).segments.map((s) => s.text)).toEqual([
      'first para',
      'second para'
    ]);
  });

  it('anchors a segment at the position of its first character', () => {
    const d = doc(para(t('hello')));
    const [segment] = analyzeDocument(d).segments;
    // Position 0 is before the paragraph; 1 is its first character.
    expect(segment.from).toBe(1);
    expect(textAt(d, segment.from, segment.text.length)).toBe('hello');
  });

  it('keeps offsets aligned across multiple blocks', () => {
    const d = doc(para(t('aa')), para(t('bbb')));
    for (const segment of analyzeDocument(d).segments) {
      expect(textAt(d, segment.from, segment.text.length)).toBe(segment.text);
    }
  });

  it('keeps offsets aligned after an inline leaf node', () => {
    // The trap: the image occupies one position but contributes no text.
    const d = doc(para(t('before '), schema.node('image'), t(' after')));
    const [segment] = analyzeDocument(d).segments;
    expect(segment.text).toHaveLength('before   after'.length);
    expect(textAt(d, segment.from, segment.text.length)).toBe(segment.text);
    // The word after the image must still map back to itself.
    const at = segment.text.indexOf('after');
    expect(textAt(d, segment.from + at, 5)).toBe('after');
  });

  it('includes headings', () => {
    const d = doc(schema.node('heading', null, [t('A title')]));
    expect(analyzeDocument(d).segments.map((s) => s.text)).toEqual(['A title']);
  });

  it('skips empty and whitespace-only blocks', () => {
    const d = doc(para(), para(t('   ')), para(t('real')));
    expect(analyzeDocument(d).segments.map((s) => s.text)).toEqual(['real']);
  });

  describe('non-prose regions', () => {
    it('excludes code blocks entirely rather than skipping them', () => {
      const d = doc(
        para(t('prose')),
        schema.node('code_block', null, [t('notaword')])
      );
      expect(analyzeDocument(d).segments.map((s) => s.text)).toEqual(['prose']);
    });

    it('marks inline code as skipped', () => {
      const d = doc(
        para(t('run '), t('npmm', [schema.mark('code')]), t(' now'))
      );
      const { segments, skips } = analyzeDocument(d);
      expect(segments[0].text).toBe('run npmm now');
      expect(skips).toHaveLength(1);
      expect(textAt(d, skips[0].from, skips[0].to - skips[0].from)).toBe(
        'npmm'
      );
    });

    it('marks wikilink text as skipped', () => {
      const link = schema.mark('link', { href: noteHref('abc') });
      const d = doc(para(t('see '), t('Meeting Notiz', [link])));
      const { skips } = analyzeDocument(d);
      expect(skips).toHaveLength(1);
      expect(textAt(d, skips[0].from, skips[0].to - skips[0].from)).toBe(
        'Meeting Notiz'
      );
    });

    it('marks @mention text as skipped', () => {
      const link = schema.mark('link', { href: userHref('jannik') });
      const d = doc(para(t('ask '), t('@jannikg', [link])));
      expect(analyzeDocument(d).skips).toHaveLength(1);
    });

    it('still checks the text of an ordinary external link', () => {
      const link = schema.mark('link', { href: 'https://example.com' });
      const d = doc(para(t('see '), t('the docs', [link])));
      expect(analyzeDocument(d).skips).toEqual([]);
    });
  });
});

describe('diagnosticDecorations', () => {
  const diag = (over: Partial<Diagnostic>): Diagnostic => ({
    from: 1,
    to: 5,
    kind: 'spelling',
    message: 'x',
    replacements: [],
    source: 'test',
    ...over
  });

  it('creates one decoration per diagnostic', () => {
    const d = doc(para(t('hello world')));
    const set = diagnosticDecorations(d, [diag({ from: 1, to: 6 })]);
    expect(set.find()).toHaveLength(1);
  });

  it('drops a diagnostic that runs past the end of the document', () => {
    // A stale result racing an edit — DecorationSet.create would throw and
    // take the editor down with it.
    const d = doc(para(t('hi')));
    expect(() =>
      diagnosticDecorations(d, [diag({ from: 1, to: 999 })])
    ).not.toThrow();
    expect(
      diagnosticDecorations(d, [diag({ from: 1, to: 999 })]).find()
    ).toEqual([]);
  });

  it('drops an empty or inverted range', () => {
    const d = doc(para(t('hello')));
    expect(diagnosticDecorations(d, [diag({ from: 3, to: 3 })]).find()).toEqual(
      []
    );
    expect(diagnosticDecorations(d, [diag({ from: 4, to: 2 })]).find()).toEqual(
      []
    );
  });
});
