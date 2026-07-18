/**
 * Auto-pair decisions on the source surface. The two exported functions are
 * pure over an `EditorState`, so these drive them directly rather than through
 * an EditorView — no DOM, and a failure points at the rule rather than at the
 * key-dispatch plumbing.
 *
 * `markdown()` is in every fixture because the code-suppression rule reads the
 * Lezer tree it maintains.
 */

import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { autoPairDelete, autoPairInput } from './auto-pair';

/** Build a state from a doc with `|` marking the caret (or `|`…`|` a
 *  selection). The markers are stripped from the document itself. */
function stateOf(marked: string): EditorState {
  const first = marked.indexOf('|');
  const doc = marked.replace(/\|/g, '');
  const second = marked.indexOf('|', first + 1);
  const anchor = first;
  const head = second === -1 ? first : second - 1;
  return EditorState.create({
    doc,
    selection: EditorSelection.range(anchor, head),
    extensions: [markdown()]
  });
}

/** Apply an input decision and render the result with `|` back at the caret,
 *  so expectations read like the fixtures. */
function typeInto(marked: string, text: string): string | null {
  const state = stateOf(marked);
  const { from, to } = state.selection.main;
  const spec = autoPairInput(state, from, to, text);
  if (!spec) return null;
  const next = state.update(spec).state;
  const doc = next.doc.toString();
  const { head } = next.selection.main;
  return doc.slice(0, head) + '|' + doc.slice(head);
}

function deleteIn(marked: string, forward: boolean): string | null {
  const state = stateOf(marked);
  const spec = autoPairDelete(state, forward);
  if (!spec) return null;
  const next = state.update(spec).state;
  const doc = next.doc.toString();
  const { head } = next.selection.main;
  return doc.slice(0, head) + '|' + doc.slice(head);
}

describe('autoPairInput', () => {
  it('closes an opener and puts the caret between the pair', () => {
    expect(typeInto('|', '(')).toBe('(|)');
    expect(typeInto('|', '[')).toBe('[|]');
    expect(typeInto('|', '{')).toBe('{|}');
  });

  it('builds [[]] from typing [ twice — the wikilink trigger', () => {
    expect(typeInto('|', '[')).toBe('[|]');
    expect(typeInto('[|]', '[')).toBe('[[|]]');
  });

  it('wraps a selection and keeps it selected', () => {
    const state = stateOf('|hello| world');
    const spec = autoPairInput(state, 0, 5, '(');
    const next = state.update(spec!).state;
    expect(next.doc.toString()).toBe('(hello) world');
    // Selection still covers "hello", shifted past the opener.
    expect(next.selection.main.from).toBe(1);
    expect(next.selection.main.to).toBe(6);
  });

  it('types through a closer instead of duplicating it', () => {
    expect(typeInto('(|)', ')')).toBe('()|');
  });

  it('inserts a closer normally when the next char is a different one', () => {
    expect(typeInto('(|]', ')')).toBeNull();
  });

  it('inserts a closer normally at the end of the document', () => {
    expect(typeInto('ab|', ')')).toBeNull();
  });

  it('does not type through when a selection would be replaced', () => {
    const state = stateOf('(|x|)');
    expect(autoPairInput(state, 1, 2, ')')).toBeNull();
  });

  it('ignores non-bracket and multi-character input', () => {
    expect(typeInto('|', 'a')).toBeNull();
    expect(typeInto('|', '((')).toBeNull();
  });

  it('leaves brackets alone inside a fenced code block', () => {
    expect(typeInto('```js\nfn|\n```', '(')).toBeNull();
  });

  it('leaves brackets alone inside an inline code span', () => {
    expect(typeInto('use `arr|` here', '[')).toBeNull();
  });

  it('still pairs in ordinary prose next to code', () => {
    expect(typeInto('`code` and |', '(')).toBe('`code` and (|)');
  });
});

describe('autoPairDelete', () => {
  it('backspaces a whole pair in one stroke', () => {
    expect(deleteIn('(|)', false)).toBe('|');
    expect(deleteIn('[[|]]', false)).toBe('[|]');
  });

  it('deletes a whole pair forward when the caret sits on the opener', () => {
    expect(deleteIn('|()', true)).toBe('|');
  });

  it('declines when the neighbours are not a matching pair', () => {
    expect(deleteIn('(|]', false)).toBeNull();
    expect(deleteIn('ab|cd', false)).toBeNull();
    expect(deleteIn('|ab', true)).toBeNull();
  });

  it('declines on an empty pair the caret is not inside', () => {
    // Caret after the closer: Backspace should just eat the `)`.
    expect(deleteIn('()|', false)).toBeNull();
  });

  it('declines at the document edges', () => {
    expect(deleteIn('|()', false)).toBeNull();
    expect(deleteIn('()|', true)).toBeNull();
  });

  it('declines when a selection is active', () => {
    const state = stateOf('(|x|)');
    expect(autoPairDelete(state, false)).toBeNull();
  });

  it('does not pair-delete inside a fenced code block', () => {
    expect(deleteIn('```js\nfn(|)\n```', false)).toBeNull();
  });

  it('does not treat brackets across a line break as a pair', () => {
    expect(deleteIn('a(\n|)b', false)).toBeNull();
  });
});
