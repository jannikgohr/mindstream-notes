import { describe, expect, it } from 'vitest';
import {
  isEmptyParagraph,
  restoreEmptyParagraphs,
  type MdastNode
} from './blank-lines';

/**
 * The parse half of the blank-line round-trip. The contract these lock in is
 * the k <-> k + 1 mapping:
 *
 *   k empty paragraphs  <->  (k + 1) blank lines
 *
 * i.e. a single blank line is the ordinary block separator and yields NO empty
 * paragraph; every blank line beyond the first becomes one. The serialize half
 * (the `join` hook in crepe-setup.ts) is the inverse, and the full loop through
 * the real Milkdown serializer is covered by
 * e2e-tests/browser/markdown-roundtrip.spec.ts.
 */

/** A paragraph occupying a single source line. */
function para(line: number, text = 'x'): MdastNode {
  return {
    type: 'paragraph',
    children: [{ type: 'text' } as MdastNode],
    position: { start: { line }, end: { line } }
  };
}

/** Build a root whose children sit on the given lines. */
function root(children: MdastNode[]): MdastNode {
  return { type: 'root', children };
}

const emptyCount = (node: MdastNode) =>
  (node.children ?? []).filter(isEmptyParagraph).length;

describe('isEmptyParagraph', () => {
  it('is true only for a childless paragraph', () => {
    expect(isEmptyParagraph({ type: 'paragraph', children: [] })).toBe(true);
    expect(isEmptyParagraph({ type: 'paragraph' })).toBe(true);
    expect(
      isEmptyParagraph({ type: 'paragraph', children: [{ type: 'text' }] })
    ).toBe(false);
    expect(isEmptyParagraph({ type: 'heading', children: [] })).toBe(false);
    expect(isEmptyParagraph(null)).toBe(false);
    expect(isEmptyParagraph(undefined)).toBe(false);
  });
});

describe('restoreEmptyParagraphs — between blocks', () => {
  it('adds nothing for a single blank line (the plain separator)', () => {
    // "a" on line 1, "b" on line 3 → exactly one blank line (line 2).
    const tree = root([para(1), para(3)]);
    restoreEmptyParagraphs(tree, 'a\n\nb\n');
    expect(tree.children).toHaveLength(2);
    expect(emptyCount(tree)).toBe(0);
  });

  it('adds one empty paragraph for two blank lines', () => {
    const tree = root([para(1), para(4)]);
    restoreEmptyParagraphs(tree, 'a\n\n\nb\n');
    expect(emptyCount(tree)).toBe(1);
    expect(tree.children).toHaveLength(3);
  });

  it('adds k empty paragraphs for k + 1 blank lines', () => {
    // gap of 4 blank lines (lines 2..5) → 3 empty paragraphs
    const tree = root([para(1), para(6)]);
    restoreEmptyParagraphs(tree, 'a\n\n\n\n\nb\n');
    expect(emptyCount(tree)).toBe(3);
  });

  it('keeps the empty paragraphs between the two real blocks', () => {
    const tree = root([para(1, 'a'), para(4, 'b')]);
    restoreEmptyParagraphs(tree, 'a\n\n\nb\n');
    expect(tree.children?.map(isEmptyParagraph)).toEqual([false, true, false]);
  });

  it('handles adjacent blocks with no blank line', () => {
    // Two nodes on consecutive lines (gap 0) — nothing inserted.
    const tree = root([para(1), para(2)]);
    restoreEmptyParagraphs(tree, 'a\nb\n');
    expect(emptyCount(tree)).toBe(0);
  });

  it('does not insert between list items (loose vs tight, not spacing)', () => {
    const list: MdastNode = {
      type: 'list',
      children: [
        { type: 'listItem', children: [para(1)] },
        { type: 'listItem', children: [para(3)] }
      ],
      position: { start: { line: 1 }, end: { line: 3 } }
    };
    const tree = root([list]);
    restoreEmptyParagraphs(tree, '- a\n\n- b\n');
    expect(list.children).toHaveLength(2);
    expect((list.children ?? []).every((c) => c.type === 'listItem')).toBe(
      true
    );
  });

  it('recurses into blockquotes', () => {
    const quote: MdastNode = {
      type: 'blockquote',
      children: [para(1), para(4)],
      position: { start: { line: 1 }, end: { line: 4 } }
    };
    const tree = root([quote]);
    restoreEmptyParagraphs(tree, '> a\n>\n>\n> b\n');
    expect(emptyCount(quote)).toBe(1);
  });

  it('treats missing positions as a plain separator', () => {
    const tree = root([{ type: 'paragraph', children: [] }, para(9)]);
    restoreEmptyParagraphs(tree, 'a\n\nb\n');
    // The synthesised node has no position → gap falls back to 1 → no inserts.
    expect(tree.children).toHaveLength(2);
  });
});

describe('restoreEmptyParagraphs — trailing blank lines', () => {
  it('adds nothing for a single trailing newline (ordinary end-of-file)', () => {
    const tree = root([para(1)]);
    restoreEmptyParagraphs(tree, 'a\n');
    expect(emptyCount(tree)).toBe(0);
  });

  it('adds nothing when the text has no trailing newline at all', () => {
    const tree = root([para(1)]);
    restoreEmptyParagraphs(tree, 'a');
    expect(emptyCount(tree)).toBe(0);
  });

  it('adds one empty paragraph for two trailing newlines', () => {
    const tree = root([para(1)]);
    restoreEmptyParagraphs(tree, 'a\n\n');
    expect(emptyCount(tree)).toBe(1);
  });

  it('adds k empty paragraphs for k + 1 trailing newlines', () => {
    const tree = root([para(1)]);
    restoreEmptyParagraphs(tree, 'a\n\n\n\n');
    expect(emptyCount(tree)).toBe(3);
  });

  it('appends the trailing empties after the last real block', () => {
    const tree = root([para(1)]);
    restoreEmptyParagraphs(tree, 'a\n\n\n');
    expect(tree.children?.map(isEmptyParagraph)).toEqual([false, true, true]);
  });

  it('leaves an empty document alone', () => {
    const tree = root([]);
    restoreEmptyParagraphs(tree, '\n\n\n');
    expect(tree.children).toHaveLength(0);
  });
});
