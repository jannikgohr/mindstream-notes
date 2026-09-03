import { describe, expect, it } from 'vitest';
import { restoreEmptyTaskItems, type MdastNode } from './task-list';

/**
 * The parse half of the empty-task-item fix. GFM refuses to read `- [ ]` as a
 * task when nothing follows the checkbox, so the marker survives as literal
 * text — which is what made a half-typed task in the Source pane show up as a
 * bullet reading "[ ]" in WYSIWYG, and get escaped to `- \[ ]` on the next
 * resync. The serialize half (`taskListItemHandler`) and the full loop through
 * the real Milkdown parser are covered by
 * e2e-tests/browser/markdown-roundtrip.spec.ts.
 */

/** A list item whose sole paragraph holds `text`, starting at `offset`. */
function item(text: string, offset: number): MdastNode {
  return {
    type: 'listItem',
    children: [
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: text, position: { start: { offset } } }
        ]
      }
    ]
  };
}

/** A single-item list rooted in `source`, with the text starting after `- `. */
function docOf(source: string, text: string): MdastNode {
  return {
    type: 'root',
    children: [
      { type: 'list', children: [item(text, source.indexOf(text[0]))] }
    ]
  };
}

const firstItem = (tree: MdastNode) => tree.children![0].children![0];

describe('restoreEmptyTaskItems', () => {
  it('turns a lone `[ ]` into an unchecked task with an empty paragraph', () => {
    const tree = docOf('- [ ]', '[ ]');
    restoreEmptyTaskItems(tree, '- [ ]');
    expect(firstItem(tree).checked).toBe(false);
    expect(firstItem(tree).children![0].children).toEqual([]);
  });

  it('reads `[x]` and `[X]` as checked', () => {
    for (const marker of ['[x]', '[X]']) {
      const source = `- ${marker}`;
      const tree = docOf(source, marker);
      restoreEmptyTaskItems(tree, source);
      expect(firstItem(tree).checked).toBe(true);
    }
  });

  it('tolerates trailing spaces after the marker', () => {
    const tree = docOf('- [ ]  ', '[ ]  ');
    restoreEmptyTaskItems(tree, '- [ ]  ');
    expect(firstItem(tree).checked).toBe(false);
  });

  it('leaves a deliberately escaped `\\[ ]` alone', () => {
    // mdast drops the backslash from the text value, so the raw source offset
    // is the only thing that still distinguishes the two.
    const source = '- \\[ ]';
    const tree: MdastNode = {
      type: 'root',
      children: [
        { type: 'list', children: [item('[ ]', source.indexOf('\\'))] }
      ]
    };
    restoreEmptyTaskItems(tree, source);
    expect(firstItem(tree).checked).toBeUndefined();
  });

  it('leaves an item that already has content alone', () => {
    const tree = docOf('- [ ] a', '[ ] a');
    restoreEmptyTaskItems(tree, '- [ ] a');
    expect(firstItem(tree).checked).toBeUndefined();
  });

  it('leaves an item GFM already resolved alone', () => {
    const tree = docOf('- [ ]', '[ ]');
    firstItem(tree).checked = true;
    restoreEmptyTaskItems(tree, '- [ ]');
    expect(firstItem(tree).checked).toBe(true);
    expect(firstItem(tree).children![0].children).toHaveLength(1);
  });

  it('recurses into nested lists', () => {
    const source = '- a\n  - [ ]';
    const inner: MdastNode = {
      type: 'list',
      children: [item('[ ]', source.lastIndexOf('['))]
    };
    const tree: MdastNode = {
      type: 'root',
      children: [
        {
          type: 'list',
          children: [
            {
              type: 'listItem',
              children: [
                { type: 'paragraph', children: [{ type: 'text', value: 'a' }] },
                inner
              ]
            }
          ]
        }
      ]
    };
    restoreEmptyTaskItems(tree, source);
    expect(inner.children![0].checked).toBe(false);
  });
});
