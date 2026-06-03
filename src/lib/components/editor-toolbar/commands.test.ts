/**
 * Tests for the list-toggle transform. The schema below mirrors Crepe's
 * actual list_item structure — crucially the `label` ("•" / "1." / …)
 * and `listType` ("bullet" / "ordered") attrs that live on each
 * list_item, NOT just on the parent list. A NodeView in Crepe's
 * list-item-block component renders the visible marker from
 * `node.attrs.label` and `node.attrs.listType` directly, so a transform
 * that flips only the parent list's node type leaves stale
 * `listType: "ordered"` / `label: "1."` on every item and the user
 * keeps seeing numbered bullets even though the parent is a bullet_list.
 * That was the actual bug — tests had been passing against a simplified
 * schema that didn't model these attrs, so they couldn't catch it.
 *
 * `checked` is added on top of the base list_item attrs by Crepe's gfm
 * task-list-item extension and behaves identically:
 *   null         → regular list_item
 *   true / false → task item, checked or not
 */

import { describe, expect, it } from 'vitest';
import { Schema, type Node as ProseNode } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { applyListAction, type ListActionTypes } from './commands';

// -- Schema -----------------------------------------------------------------

const testSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      toDOM: () => ['p', 0]
    },
    heading: {
      attrs: { level: { default: 1 } },
      content: 'inline*',
      group: 'block',
      toDOM: (n) => [`h${n.attrs.level}`, 0]
    },
    code_block: {
      content: 'text*',
      group: 'block',
      code: true,
      toDOM: () => ['pre', ['code', 0]]
    },
    bullet_list: {
      content: 'list_item+',
      group: 'block',
      attrs: { spread: { default: true } },
      toDOM: () => ['ul', 0]
    },
    ordered_list: {
      content: 'list_item+',
      group: 'block',
      attrs: { order: { default: 1 }, spread: { default: false } },
      toDOM: () => ['ol', 0]
    },
    list_item: {
      content: 'paragraph block*',
      attrs: {
        label: { default: '•' },
        listType: { default: 'bullet' },
        spread: { default: true },
        checked: { default: null }
      },
      toDOM: () => ['li', 0]
    },
    text: { group: 'inline' }
  },
  marks: {}
});

const types: ListActionTypes = {
  bulletList: testSchema.nodes.bullet_list,
  orderedList: testSchema.nodes.ordered_list,
  listItem: testSchema.nodes.list_item,
  paragraph: testSchema.nodes.paragraph
};

// -- Builders ---------------------------------------------------------------

function p(text: string): ProseNode {
  return testSchema.node(
    'paragraph',
    null,
    text ? [testSchema.text(text)] : []
  );
}
function h(level: number, text: string): ProseNode {
  return testSchema.node('heading', { level }, [testSchema.text(text)]);
}
function code(text: string): ProseNode {
  return testSchema.node('code_block', null, [testSchema.text(text)]);
}

/** Bullet list_item. `checked` non-null makes it a task item. */
function li(text: string, checked: unknown = null): ProseNode {
  return testSchema.node(
    'list_item',
    { label: '•', listType: 'bullet', spread: true, checked },
    [p(text)]
  );
}

/** Bullet list. Strings get wrapped via `li()`; pre-built list_items pass
 *  through untouched so you can mix in `li('foo', true)` for a checked
 *  task item. */
function ul(...items: Array<string | ProseNode>): ProseNode {
  const nodes = items.map((it) => (typeof it === 'string' ? li(it) : it));
  return testSchema.node('bullet_list', null, nodes);
}

/** Ordered list. Items get auto-numbered labels ("1.", "2.", …) and
 *  `listType: "ordered"` so the rendered structure mirrors what Crepe's
 *  markdown parser would produce. */
function ol(...items: Array<string | ProseNode>): ProseNode {
  const nodes = items.map((it, i) => {
    const label = `${i + 1}.`;
    if (typeof it === 'string') {
      return testSchema.node(
        'list_item',
        { label, listType: 'ordered', spread: true, checked: null },
        [p(it)]
      );
    }
    // Coerce a passed-in li to ordered, taking the sequential label.
    return testSchema.node(
      'list_item',
      { ...it.attrs, label, listType: 'ordered' },
      it.content
    );
  });
  return testSchema.node('ordered_list', null, nodes);
}

function makeDoc(...nodes: ProseNode[]): ProseNode {
  return testSchema.node('doc', null, nodes);
}

// -- State helpers ----------------------------------------------------------

function stateOf(doc: ProseNode): EditorState {
  return EditorState.create({ doc });
}

function withCursorAt(state: EditorState, pos: number): EditorState {
  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, pos))
  );
}

function withSelectionAll(state: EditorState): EditorState {
  const sel = TextSelection.between(
    state.doc.resolve(0),
    state.doc.resolve(state.doc.content.size)
  );
  return state.apply(state.tr.setSelection(sel));
}

function run(
  state: EditorState,
  target: 'bullet' | 'ordered' | 'task'
): ProseNode {
  let out = state;
  applyListAction(
    state,
    (tr) => {
      out = state.apply(tr);
    },
    target,
    types
  );
  return out.doc;
}

/**
 * Compact label tree for assertions. List_items render their salient attrs:
 *   li(...)        → regular bullet (label "•", listType "bullet")
 *   li:N.(...)     → ordered item with label "N." (listType "ordered")
 *   li○(...)       → unchecked task item
 *   li●(...)       → checked task item
 *   li:ord(...)    → label/listType inconsistency (catches the bug fixed
 *                    in this file: parent flipped to bullet_list but the
 *                    list_item kept listType="ordered")
 */
function structure(doc: ProseNode): string {
  const parts: string[] = [];
  doc.forEach((child) => parts.push(renderNode(child)));
  return parts.join(' ');
}
function renderNode(node: ProseNode): string {
  switch (node.type.name) {
    case 'paragraph':
      return `p(${node.textContent})`;
    case 'heading':
      return `h${node.attrs.level}(${node.textContent})`;
    case 'code_block':
      return `code(${node.textContent})`;
    case 'bullet_list':
    case 'ordered_list': {
      const tag = node.type.name === 'bullet_list' ? 'ul' : 'ol';
      const items: string[] = [];
      node.forEach((it) => items.push(renderNode(it)));
      return `${tag}[${items.join(' ')}]`;
    }
    case 'list_item': {
      const { label, listType, checked } = node.attrs;
      const inner: string[] = [];
      node.forEach((c) => inner.push(renderNode(c)));
      let prefix = 'li';
      if (checked === false) prefix += '○';
      else if (checked === true) prefix += '●';
      // Only show the label when it deviates from the default bullet
      // marker; that keeps regular bullet items visually clean while
      // still surfacing "1.", "2." for ordered items and surfacing
      // any leftover stale label on a bullet item (bug indicator).
      if (label && label !== '•') prefix += `:${label}`;
      // Catch the "listType is ordered but label still default" case
      // separately so a bug that fixes one attr but not the other is
      // still visible.
      else if (listType === 'ordered') prefix += ':ord';
      return `${prefix}(${inner.join(' ')})`;
    }
    default:
      return node.type.name;
  }
}

// -- Single-line behaviour --------------------------------------------------

describe('applyListAction — single line', () => {
  it('wraps a plain paragraph in a bullet list', () => {
    const s = withCursorAt(stateOf(makeDoc(p('hello'))), 2);
    expect(structure(run(s, 'bullet'))).toBe('ul[li(p(hello))]');
  });

  it('wraps a plain paragraph in an ordered list with label "1."', () => {
    const s = withCursorAt(stateOf(makeDoc(p('hello'))), 2);
    expect(structure(run(s, 'ordered'))).toBe('ol[li:1.(p(hello))]');
  });

  it('wraps a plain paragraph in a task list with checked=false', () => {
    const s = withCursorAt(stateOf(makeDoc(p('hello'))), 2);
    expect(structure(run(s, 'task'))).toBe('ul[li○(p(hello))]');
  });

  it('coerces a heading to paragraph before wrapping in a list', () => {
    const s = withCursorAt(stateOf(makeDoc(h(2, 'hi'))), 2);
    expect(structure(run(s, 'bullet'))).toBe('ul[li(p(hi))]');
  });

  it('toggles a single-item bullet list off', () => {
    const s = withCursorAt(stateOf(makeDoc(ul('hello'))), 4);
    expect(structure(run(s, 'bullet'))).toBe('p(hello)');
  });

  it('switches a bullet list to ordered — list_item label/listType update', () => {
    const s = withCursorAt(stateOf(makeDoc(ul('hello'))), 4);
    expect(structure(run(s, 'ordered'))).toBe('ol[li:1.(p(hello))]');
  });

  // The asymmetric bug the user reported: bullet→ordered worked because
  // the parent type change "looked right" cosmetically, but ordered→bullet
  // visibly didn't because each list_item kept its label="1." and
  // listType="ordered" attrs and the NodeView rendered numbered items.
  it('switches an ordered list to bullet — list_item label/listType reset', () => {
    const s = withCursorAt(stateOf(makeDoc(ol('hello'))), 4);
    expect(structure(run(s, 'bullet'))).toBe('ul[li(p(hello))]');
  });

  it('toggles an ordered list off', () => {
    const s = withCursorAt(stateOf(makeDoc(ol('hello'))), 4);
    expect(structure(run(s, 'ordered'))).toBe('p(hello)');
  });

  it('switches an ordered list to task — listType reset to bullet, checked=false', () => {
    const s = withCursorAt(stateOf(makeDoc(ol('hello'))), 4);
    expect(structure(run(s, 'task'))).toBe('ul[li○(p(hello))]');
  });

  it('switches a bullet item to a task item (gains checked=false)', () => {
    const s = withCursorAt(stateOf(makeDoc(ul('hello'))), 4);
    expect(structure(run(s, 'task'))).toBe('ul[li○(p(hello))]');
  });

  it('switches a task item back to a bullet (clears checked)', () => {
    const s = withCursorAt(stateOf(makeDoc(ul(li('hello', false)))), 4);
    expect(structure(run(s, 'bullet'))).toBe('ul[li(p(hello))]');
  });

  it('toggles a task item off', () => {
    const s = withCursorAt(stateOf(makeDoc(ul(li('hello', false)))), 4);
    expect(structure(run(s, 'task'))).toBe('p(hello)');
  });

  it('no-ops inside a code block', () => {
    const s = withCursorAt(stateOf(makeDoc(code('x'))), 2);
    expect(structure(run(s, 'bullet'))).toBe('code(x)');
  });
});

// -- Multi-line behaviour ---------------------------------------------------

describe('applyListAction — multi line', () => {
  it('wraps three plain paragraphs as one bullet list with three items', () => {
    const s = withSelectionAll(
      stateOf(makeDoc(p('one'), p('two'), p('three')))
    );
    expect(structure(run(s, 'bullet'))).toBe(
      'ul[li(p(one)) li(p(two)) li(p(three))]'
    );
  });

  it('wraps three plain paragraphs as one ordered list (1. 2. 3.)', () => {
    const s = withSelectionAll(
      stateOf(makeDoc(p('one'), p('two'), p('three')))
    );
    expect(structure(run(s, 'ordered'))).toBe(
      'ol[li:1.(p(one)) li:2.(p(two)) li:3.(p(three))]'
    );
  });

  it('wraps three plain paragraphs as one task list', () => {
    const s = withSelectionAll(
      stateOf(makeDoc(p('one'), p('two'), p('three')))
    );
    expect(structure(run(s, 'task'))).toBe(
      'ul[li○(p(one)) li○(p(two)) li○(p(three))]'
    );
  });

  it('toggles an all-bullet selection off', () => {
    const s = withSelectionAll(stateOf(makeDoc(ul('one', 'two', 'three'))));
    expect(structure(run(s, 'bullet'))).toBe('p(one) p(two) p(three)');
  });

  it('toggles an all-ordered selection off', () => {
    const s = withSelectionAll(stateOf(makeDoc(ol('one', 'two', 'three'))));
    expect(structure(run(s, 'ordered'))).toBe('p(one) p(two) p(three)');
  });

  it('switches three bullet items to ordered (the reported-working direction)', () => {
    const s = withSelectionAll(stateOf(makeDoc(ul('one', 'two', 'three'))));
    expect(structure(run(s, 'ordered'))).toBe(
      'ol[li:1.(p(one)) li:2.(p(two)) li:3.(p(three))]'
    );
  });

  it('switches three ordered items to three bullet items in one merged list', () => {
    // Symmetric counterpart of the test above — the direction the user
    // reported as broken. The crucial assertion is `li(...)` and NOT
    // `li:1.(...)` — i.e. the list_item label/listType actually got
    // reset, not just the parent list's node type.
    const s = withSelectionAll(stateOf(makeDoc(ol('one', 'two', 'three'))));
    expect(structure(run(s, 'bullet'))).toBe(
      'ul[li(p(one)) li(p(two)) li(p(three))]'
    );
  });

  it('unifies bullet + ordered to bullet — single merged ul (original bug report)', () => {
    // * one
    // * two
    // 1. three
    // 2. four
    // → click Bullet → four bullets in ONE list, NO leftover "1." / "2." labels.
    const s = withSelectionAll(
      stateOf(makeDoc(ul('one', 'two'), ol('three', 'four')))
    );
    expect(structure(run(s, 'bullet'))).toBe(
      'ul[li(p(one)) li(p(two)) li(p(three)) li(p(four))]'
    );
  });

  it('unifies bullet + ordered to ordered — single merged ol with renumbered labels', () => {
    const s = withSelectionAll(
      stateOf(makeDoc(ul('one', 'two'), ol('three', 'four')))
    );
    expect(structure(run(s, 'ordered'))).toBe(
      'ol[li:1.(p(one)) li:2.(p(two)) li:3.(p(three)) li:4.(p(four))]'
    );
  });

  it('unifies bullet + ordered to task — listType reset on every item', () => {
    const s = withSelectionAll(stateOf(makeDoc(ul('one'), ol('two'))));
    expect(structure(run(s, 'task'))).toBe('ul[li○(p(one)) li○(p(two))]');
  });

  it('unifies a mix of task and bullet to bullet (clears checked, merges)', () => {
    const s = withSelectionAll(
      stateOf(makeDoc(ul(li('one', false), li('two', true)), ul('three')))
    );
    expect(structure(run(s, 'bullet'))).toBe(
      'ul[li(p(one)) li(p(two)) li(p(three))]'
    );
  });

  it('does not toggle off when not every block matches target', () => {
    const s = withSelectionAll(stateOf(makeDoc(ul('one', 'two'), ol('three'))));
    expect(structure(run(s, 'ordered'))).toBe(
      'ol[li:1.(p(one)) li:2.(p(two)) li:3.(p(three))]'
    );
  });

  it('toggles a mix of task and task-bullet off (both count as task)', () => {
    const s = withSelectionAll(
      stateOf(makeDoc(ul(li('done', true), li('todo', false))))
    );
    expect(structure(run(s, 'task'))).toBe('p(done) p(todo)');
  });

  it('coerces headings in a mixed selection to paragraphs inside one list', () => {
    const s = withSelectionAll(stateOf(makeDoc(h(1, 'title'), p('body'))));
    expect(structure(run(s, 'bullet'))).toBe('ul[li(p(title)) li(p(body))]');
  });

  it('no-ops when the selection touches a code block', () => {
    const s = withSelectionAll(
      stateOf(makeDoc(p('one'), code('x'), p('three')))
    );
    expect(structure(run(s, 'bullet'))).toBe('p(one) code(x) p(three)');
  });

  it('keeps lists separate when a non-list block sits between them', () => {
    const doc = makeDoc(ul('one'), p('between'), ul('two'));
    const s = withSelectionAll(stateOf(doc));
    expect(structure(run(s, 'bullet'))).toBe(
      'ul[li(p(one)) li(p(between)) li(p(two))]'
    );
  });
});

// -- Partial-list edge cases ------------------------------------------------

describe('applyListAction — partial list selections', () => {
  it('splits a bullet list when only the middle item is toggled off', () => {
    const doc = makeDoc(ul('A', 'B', 'C'));
    const s = stateOf(doc);
    // li(A) nodeSize: li(1) + p(1) + text(1) + p(1) + li(1) = 5? plus inner
    // We need cursor inside B's paragraph text.
    let textPos = 1; // open ul
    textPos += 1; // open li(A)
    textPos += 1; // open p
    textPos += 1; // text "A"
    textPos += 1; // close p
    textPos += 1; // close li(A)
    textPos += 1; // open li(B)
    textPos += 1; // open p
    const cursor = withCursorAt(s, textPos);
    expect(structure(run(cursor, 'bullet'))).toBe(
      'ul[li(p(A))] p(B) ul[li(p(C))]'
    );
  });

  it('renumbers an ordered list when its middle item is toggled off', () => {
    // ol[1. A, 2. B, 3. C] → toggle middle off → ol[1. A] + p(B) + ol[1. C]
    // (each kept list_item segment renumbers from 1)
    const doc = makeDoc(ol('A', 'B', 'C'));
    const s = stateOf(doc);
    let textPos = 1; // open ol
    textPos += 1; // open li(A)
    textPos += 1; // open p
    textPos += 1; // text
    textPos += 1; // close p
    textPos += 1; // close li(A)
    textPos += 1; // open li(B)
    textPos += 1; // open p
    const cursor = withCursorAt(s, textPos);
    expect(structure(run(cursor, 'ordered'))).toBe(
      'ol[li:1.(p(A))] p(B) ol[li:1.(p(C))]'
    );
  });
});

// -- Round-trip: convert + convert back -------------------------------------

describe('applyListAction — round-trip', () => {
  // The user observed: "Though if I apply bullet point list a second time
  // it removes the list style." That tells us the FIRST application
  // changes the doc (otherwise the second wouldn't see "all bullet" and
  // toggle off). The bug was that the visible RENDER didn't update
  // because list_item attrs hadn't been synced. With the fix in place,
  // both halves of the user's observation should hold cleanly:
  //   1st click: bullet + ordered → one merged bullet list
  //   2nd click: that bullet list toggles off
  it('applying bullet twice to a mixed list flattens to paragraphs', () => {
    const initial = stateOf(makeDoc(ul('one', 'two'), ol('three', 'four')));
    const sel = TextSelection.between(
      initial.doc.resolve(0),
      initial.doc.resolve(initial.doc.content.size)
    );
    const start = initial.apply(initial.tr.setSelection(sel));

    let mid = start;
    applyListAction(
      start,
      (tr) => {
        mid = start.apply(tr);
      },
      'bullet',
      types
    );
    expect(structure(mid.doc)).toBe(
      'ul[li(p(one)) li(p(two)) li(p(three)) li(p(four))]'
    );

    // Re-select all in the new doc, then apply bullet again.
    const midSel = TextSelection.between(
      mid.doc.resolve(0),
      mid.doc.resolve(mid.doc.content.size)
    );
    const midSelected = mid.apply(mid.tr.setSelection(midSel));
    let final = midSelected;
    applyListAction(
      midSelected,
      (tr) => {
        final = midSelected.apply(tr);
      },
      'bullet',
      types
    );
    expect(structure(final.doc)).toBe('p(one) p(two) p(three) p(four)');
  });
});
