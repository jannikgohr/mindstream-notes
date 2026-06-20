/**
 * Unit tests for the find/replace match scanner. We build docs against a
 * minimal ProseMirror schema (doc / paragraph / heading / text + an inline
 * atom) rather than Milkdown's full schema — `findMatches` only cares about
 * `isTextblock` + inline children, so this exercises the position-mapping
 * and block-scoping logic that the replace transactions depend on.
 */

import { describe, expect, it } from 'vitest';
import { Schema, type Node as ProseNode } from '@milkdown/kit/prose/model';
import { findMatches } from './markdown-search';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*' },
    // Inline atom (e.g. an inline image) — has no text, so a match must
    // never span across it.
    atom: { group: 'inline', inline: true, atom: true },
    text: { group: 'inline' }
  },
  marks: {
    strong: {}
  }
});

const { doc, paragraph, heading, atom } = {
  doc: (...children: ProseNode[]) => schema.node('doc', null, children),
  paragraph: (...children: ProseNode[]) =>
    schema.node('paragraph', null, children),
  heading: (...children: ProseNode[]) => schema.node('heading', null, children),
  atom: () => schema.node('atom')
};
const text = (value: string, strong = false) =>
  schema.text(value, strong ? [schema.mark('strong')] : []);

/** The substring at a match's range, for a readable assertion. */
function sliceAt(node: ProseNode, match: { from: number; to: number }) {
  return node.textBetween(match.from, match.to);
}

describe('findMatches', () => {
  it('returns nothing for an empty query', () => {
    const node = doc(paragraph(text('hello world')));
    expect(findMatches(node, '')).toEqual([]);
  });

  it('finds every occurrence and maps positions back to the slice', () => {
    const node = doc(paragraph(text('one two one two one')));
    const matches = findMatches(node, 'one');
    expect(matches).toHaveLength(3);
    for (const match of matches) {
      expect(sliceAt(node, match)).toBe('one');
    }
  });

  it('is case-insensitive', () => {
    const node = doc(paragraph(text('Foo foo FOO')));
    expect(findMatches(node, 'foo')).toHaveLength(3);
  });

  it('matches across mark boundaries within a block', () => {
    // "high" + bold "light" — one logical word split over two text nodes.
    const node = doc(paragraph(text('high'), text('light', true)));
    const matches = findMatches(node, 'highlight');
    expect(matches).toHaveLength(1);
    expect(sliceAt(node, matches[0])).toBe('highlight');
  });

  it('does not match across a text block boundary', () => {
    const node = doc(paragraph(text('foo')), paragraph(text('bar')));
    expect(findMatches(node, 'foobar')).toEqual([]);
  });

  it('does not match across an inline atom', () => {
    const node = doc(paragraph(text('ab'), atom(), text('cd')));
    expect(findMatches(node, 'abcd')).toEqual([]);
    // …but text on either side of the atom still matches.
    expect(findMatches(node, 'ab')).toHaveLength(1);
    expect(findMatches(node, 'cd')).toHaveLength(1);
  });

  it('finds matches inside any text block kind, in document order', () => {
    const node = doc(
      heading(text('title match')),
      paragraph(text('body match'))
    );
    const matches = findMatches(node, 'match');
    expect(matches).toHaveLength(2);
    // First match sits in the heading (earlier in the doc).
    expect(matches[0].from).toBeLessThan(matches[1].from);
  });

  it('does not overlap consecutive matches', () => {
    // "aa" in "aaaa" → two non-overlapping hits, not three.
    const node = doc(paragraph(text('aaaa')));
    const matches = findMatches(node, 'aa');
    expect(matches).toHaveLength(2);
    expect(matches[0].to).toBeLessThanOrEqual(matches[1].from);
  });
});
