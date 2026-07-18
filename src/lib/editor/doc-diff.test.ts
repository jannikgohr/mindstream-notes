import { describe, expect, it } from 'vitest';
import { Schema, type Node as ProseNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { minimalDocDiff } from './doc-diff';

/**
 * These lock in the property that keeps the Yjs document from ballooning: a
 * source edit must replace only the range that actually changed, never the whole
 * document. `applyTemplate` (which this replaced) deleted and re-inserted the
 * entire XmlFragment on every call — on a 2.6 kB note that cost ~457 bytes of
 * append-only Yjs history PER KEYSTROKE; the diff costs ~2.
 */

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' }
  }
});

/** Build a doc of paragraphs; '' yields an empty paragraph. */
function doc(...paragraphs: string[]): ProseNode {
  return schema.node(
    'doc',
    null,
    paragraphs.map((t) =>
      schema.node('paragraph', null, t ? [schema.text(t)] : [])
    )
  );
}

/** Apply the computed diff to `a` and return the resulting document. */
function applyDiff(a: ProseNode, b: ProseNode): ProseNode {
  const diff = minimalDocDiff(a, b);
  if (!diff) return a;
  const state = EditorState.create({ doc: a, schema });
  return state.tr.replace(diff.from, diff.to, diff.slice).doc;
}

describe('minimalDocDiff', () => {
  it('returns null for identical documents (so we emit no Yjs ops at all)', () => {
    expect(minimalDocDiff(doc('one', 'two'), doc('one', 'two'))).toBeNull();
  });

  it('applying the diff reproduces the target document', () => {
    const cases: [ProseNode, ProseNode][] = [
      [doc('one', 'two'), doc('one', 'TWO')],
      [doc('one'), doc('one', 'two')], // append
      [doc('one', 'two'), doc('one')], // delete
      [doc('a', 'b', 'c'), doc('a', 'x', 'c')], // middle swap
      [doc('one'), doc('zero', 'one')], // prepend
      [doc('a'), doc('')], // becomes empty
      [doc('same', 'same'), doc('same', 'same', 'same')] // repeated content
    ];
    for (const [a, b] of cases) {
      expect(applyDiff(a, b).eq(b)).toBe(true);
    }
  });

  it('touches only the changed region, not the whole document', () => {
    const build = (tenth: string) =>
      doc(
        ...Array.from({ length: 20 }, (_, i) =>
          i === 10 ? tenth : `para ${i}`
        )
      );
    const a = build('para 10');
    const b = build('para 10 CHANGED');

    const diff = minimalDocDiff(a, b);
    expect(diff).not.toBeNull();
    // The edit is a few characters deep inside a 20-paragraph document: the
    // replaced range must be a sliver of it, not the lot. This is the assertion
    // that would have caught the applyTemplate whole-document rewrite.
    expect(diff!.to - diff!.from).toBeLessThan(20);
    expect(diff!.from).toBeGreaterThan(0);
    expect(diff!.to).toBeLessThan(a.content.size);
    expect(applyDiff(a, b).eq(b)).toBe(true);
  });

  it('scales with the edit, not the document size', () => {
    const build = (n: number, last: string) =>
      doc(
        ...Array.from({ length: n }, (_, i) =>
          i === n - 1 ? last : `para ${i}`
        )
      );
    // Same one-character edit in a small and a large document.
    const small = minimalDocDiff(build(3, 'tail'), build(3, 'tailX'))!;
    const large = minimalDocDiff(build(60, 'tail'), build(60, 'tailX'))!;
    expect(large.to - large.from).toBe(small.to - small.from);
  });

  it('keeps a well-formed range when content repeats around the change', () => {
    // Repeated text makes the from/back scans overlap — the guard must keep
    // from <= to rather than produce an inverted range.
    const a = doc('x', 'x', 'x');
    const b = doc('x', 'x');
    const diff = minimalDocDiff(a, b);
    expect(diff).not.toBeNull();
    expect(diff!.from).toBeLessThanOrEqual(diff!.to);
    expect(applyDiff(a, b).eq(b)).toBe(true);
  });
});
