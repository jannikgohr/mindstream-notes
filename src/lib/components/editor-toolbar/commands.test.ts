/**
 * Tests for the list-toggle transform. We build a minimal ProseMirror
 * schema that mirrors the relevant slice of Crepe's commonmark + gfm
 * task-list-item schema (the `checked` attr on `list_item`), construct
 * documents and selections by hand, and call `applyListAction` directly
 * — no Milkdown editor, no DOM, no Svelte. That keeps the tests fast
 * and avoids pulling Crepe's whole render pipeline into vitest.
 */

import { describe, expect, it } from 'vitest';
import { Schema, type Node as ProseNode } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { applyListAction, type ListActionTypes } from './commands';

// -- Schema mirroring Crepe's commonmark + task-list-item --------------------

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
      toDOM: () => ['ul', 0]
    },
    ordered_list: {
      content: 'list_item+',
      group: 'block',
      toDOM: () => ['ol', 0]
    },
    list_item: {
      content: 'paragraph block*',
      // `checked` mirrors Crepe's gfm task-list-item extension:
      //   null         → regular list_item
      //   true / false → task item, checked or not
      attrs: { checked: { default: null } },
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
  return testSchema.node('paragraph', null, text ? [testSchema.text(text)] : []);
}
function h(level: number, text: string): ProseNode {
  return testSchema.node('heading', { level }, [testSchema.text(text)]);
}
function code(text: string): ProseNode {
  return testSchema.node('code_block', null, [testSchema.text(text)]);
}
function li(text: string, checked: unknown = null): ProseNode {
  return testSchema.node('list_item', { checked }, [p(text)]);
}
function ul(...items: ProseNode[]): ProseNode {
  return testSchema.node('bullet_list', null, items);
}
function ol(...items: ProseNode[]): ProseNode {
  return testSchema.node('ordered_list', null, items);
}
function makeDoc(...nodes: ProseNode[]): ProseNode {
  return testSchema.node('doc', null, nodes);
}

// -- State helpers ----------------------------------------------------------

function stateOf(doc: ProseNode): EditorState {
  return EditorState.create({ doc });
}

/** Place the caret inside whichever textblock is at the given doc position. */
function withCursorAt(state: EditorState, pos: number): EditorState {
  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, pos))
  );
}

/** Select from the first text position to the last — i.e. the whole doc. */
function withSelectionAll(state: EditorState): EditorState {
  const sel = TextSelection.between(
    state.doc.resolve(0),
    state.doc.resolve(state.doc.content.size)
  );
  return state.apply(state.tr.setSelection(sel));
}

/** Run the action and return the resulting doc — what the user would see. */
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
 * Pretty-print the doc structure into a compact label tree, e.g.:
 *   `ul[li(one) li(two)] ol[li(three) li(four)]`
 * Used in assertions for readable diffs.
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
      const inner: string[] = [];
      node.forEach((c) => inner.push(renderNode(c)));
      const mark =
        node.attrs.checked === false
          ? '○'
          : node.attrs.checked === true
            ? '●'
            : '';
      return `li${mark}(${inner.join(' ')})`;
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

  it('wraps a plain paragraph in an ordered list', () => {
    const s = withCursorAt(stateOf(makeDoc(p('hello'))), 2);
    expect(structure(run(s, 'ordered'))).toBe('ol[li(p(hello))]');
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
    const s = withCursorAt(stateOf(makeDoc(ul(li('hello')))), 4);
    expect(structure(run(s, 'bullet'))).toBe('p(hello)');
  });

  it('switches a bullet list to ordered', () => {
    const s = withCursorAt(stateOf(makeDoc(ul(li('hello')))), 4);
    expect(structure(run(s, 'ordered'))).toBe('ol[li(p(hello))]');
  });

  it('switches a bullet item to a task item (gains checked=false)', () => {
    const s = withCursorAt(stateOf(makeDoc(ul(li('hello')))), 4);
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
    // Regression: previously emitted three separate `ul`s, which markdown
    // serialized as three blank-line-separated lists each starting at "*".
    const s = withSelectionAll(stateOf(makeDoc(p('one'), p('two'), p('three'))));
    expect(structure(run(s, 'bullet'))).toBe(
      'ul[li(p(one)) li(p(two)) li(p(three))]'
    );
  });

  it('wraps three plain paragraphs as one ordered list (1. 2. 3.)', () => {
    // Regression: previously emitted three separate `ol`s, so the markdown
    // came out as "1. one / 1. two / 1. three" instead of 1./2./3.
    const s = withSelectionAll(stateOf(makeDoc(p('one'), p('two'), p('three'))));
    expect(structure(run(s, 'ordered'))).toBe(
      'ol[li(p(one)) li(p(two)) li(p(three))]'
    );
  });

  it('wraps three plain paragraphs as one task list', () => {
    const s = withSelectionAll(stateOf(makeDoc(p('one'), p('two'), p('three'))));
    expect(structure(run(s, 'task'))).toBe(
      'ul[li○(p(one)) li○(p(two)) li○(p(three))]'
    );
  });

  it('toggles an all-bullet selection off', () => {
    const s = withSelectionAll(stateOf(makeDoc(ul(li('one'), li('two'), li('three')))));
    expect(structure(run(s, 'bullet'))).toBe('p(one) p(two) p(three)');
  });

  it('unifies bullet + ordered to bullet — single merged ul (original bug report)', () => {
    // * one
    // * two
    // 1. three
    // 2. four
    // → click Bullet → all four in ONE bullet list.
    const s = withSelectionAll(
      stateOf(makeDoc(ul(li('one'), li('two')), ol(li('three'), li('four'))))
    );
    expect(structure(run(s, 'bullet'))).toBe(
      'ul[li(p(one)) li(p(two)) li(p(three)) li(p(four))]'
    );
  });

  it('unifies bullet + ordered to ordered — single merged ol', () => {
    const s = withSelectionAll(
      stateOf(makeDoc(ul(li('one'), li('two')), ol(li('three'), li('four'))))
    );
    expect(structure(run(s, 'ordered'))).toBe(
      'ol[li(p(one)) li(p(two)) li(p(three)) li(p(four))]'
    );
  });

  it('unifies bullet + ordered to task — single merged ul of task items', () => {
    const s = withSelectionAll(
      stateOf(makeDoc(ul(li('one')), ol(li('two'))))
    );
    expect(structure(run(s, 'task'))).toBe(
      'ul[li○(p(one)) li○(p(two))]'
    );
  });

  it('unifies a mix of task and bullet to bullet (clears checked, merges)', () => {
    const s = withSelectionAll(
      stateOf(makeDoc(ul(li('one', false), li('two', true)), ul(li('three'))))
    );
    expect(structure(run(s, 'bullet'))).toBe(
      'ul[li(p(one)) li(p(two)) li(p(three))]'
    );
  });

  it('does not toggle off when not every block matches target', () => {
    // Two bullets + one ordered, click Ordered → all become ordered in one list.
    const s = withSelectionAll(
      stateOf(makeDoc(ul(li('one'), li('two')), ol(li('three'))))
    );
    expect(structure(run(s, 'ordered'))).toBe(
      'ol[li(p(one)) li(p(two)) li(p(three))]'
    );
  });

  it('toggles a mix of task and task-bullet off (both count as task)', () => {
    // Both unchecked-task and checked-task report as "task", so a
    // selection of mixed checked-states is uniformly target=task.
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
    const s = withSelectionAll(stateOf(makeDoc(p('one'), code('x'), p('three'))));
    expect(structure(run(s, 'bullet'))).toBe('p(one) code(x) p(three)');
  });

  it('merges a new list into an existing same-type list above', () => {
    // ul above, plain p below, select only p, click Bullet → one ul[3].
    const doc = makeDoc(ul(li('one'), li('two')), p('three'));
    const s = doc;
    const state = stateOf(doc);
    // Cursor inside "three": doc size up to and including the ul, then
    // +1 for the start of the trailing paragraph, +1 for the start of
    // its inline content.
    const cursor = state.doc.resolve(state.doc.nodeSize - 4); // inside "three"
    const cursored = state.apply(state.tr.setSelection(TextSelection.near(cursor)));
    expect(structure(run(cursored, 'bullet'))).toBe(
      'ul[li(p(one)) li(p(two)) li(p(three))]'
    );
  });

  it('keeps lists separate when a non-list block sits between them', () => {
    // Selecting only the two bullets across a separating paragraph
    // shouldn't pull the paragraph into the list, nor should the
    // post-pass join lists that were always supposed to be separate.
    const doc = makeDoc(ul(li('one')), p('between'), ul(li('two')));
    const s = withSelectionAll(stateOf(doc));
    // Selection-all hits the middle paragraph, which is not in a list →
    // unify path wraps it too, all three end up merged.
    expect(structure(run(s, 'bullet'))).toBe(
      'ul[li(p(one)) li(p(between)) li(p(two))]'
    );
  });
});

// -- Partial-list edge cases ------------------------------------------------

describe('applyListAction — partial list selections', () => {
  it('splits a bullet list when only the middle item is toggled off', () => {
    // ul[A B C], cursor in B, click Bullet → ul[A] + p(B) + ul[C]
    const doc = makeDoc(ul(li('A'), li('B'), li('C')));
    const s = stateOf(doc);
    // li(A) takes 6 positions (li open, p open, "A", p close, li close).
    // Actually each li(text-of-1) has size: li(1) + p(1) + text(1) + p(1) + li(1) = nodeSize 6.
    // Position 0 = before ul. Inside ul at 1. Inside first li at 2. Inside its p at 3 = before 'A'.
    // li(A) ends at position 7. li(B) starts at 7. Inside li(B)'s p text = position 10.
    let textPos = 1; // open ul
    textPos += 1; // open li(A)
    textPos += 1; // open p
    textPos += 1; // text "A"
    textPos += 1; // close p
    textPos += 1; // close li(A)
    textPos += 1; // open li(B)
    textPos += 1; // open p
    // textPos is now the position of the first text char in B's paragraph.
    const cursor = withCursorAt(s, textPos);
    expect(structure(run(cursor, 'bullet'))).toBe(
      'ul[li(p(A))] p(B) ul[li(p(C))]'
    );
  });

  it('changes only the selected items to a different list (whole-list selection)', () => {
    // Selecting the entire ul flips the list type; the bullet list becomes ordered.
    const s = withSelectionAll(stateOf(makeDoc(ul(li('one'), li('two')))));
    expect(structure(run(s, 'ordered'))).toBe('ol[li(p(one)) li(p(two))]');
  });
});
