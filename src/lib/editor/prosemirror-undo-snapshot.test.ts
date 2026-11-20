import { describe, expect, it } from 'vitest';
import { Schema, type Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import {
  closeHistory,
  history,
  redo,
  redoDepth,
  undo,
  undoDepth
} from '@milkdown/kit/prose/history';
import {
  captureProseMirrorUndo,
  restoreProseMirrorUndo
} from './prosemirror-undo-snapshot';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' }
  }
});

function doc(...paragraphs: string[]): ProseNode {
  return schema.node(
    'doc',
    null,
    paragraphs.map((t) =>
      schema.node('paragraph', null, t ? [schema.text(t)] : [])
    )
  );
}

function editor(start: ProseNode) {
  let state = EditorState.create({ doc: start, plugins: [history()] });
  return {
    get state() {
      return state;
    },
    type(at: number, text: string) {
      state = state.apply(closeHistory(state.tr.insertText(text, at)));
    },
    run(command: typeof undo) {
      return command(state, (tr) => (state = state.apply(tr)));
    },
    load(next: EditorState) {
      state = next;
    }
  };
}

/** The window is unloaded and built again: same document, fresh history. */
function reopen(from: EditorState, current = from.doc) {
  const saved = JSON.parse(JSON.stringify(captureProseMirrorUndo(from)));
  const fresh = editor(current);
  const restore = restoreProseMirrorUndo(fresh.state, saved);
  expect(restore).not.toBeNull();
  fresh.load(fresh.state.apply(restore!));
  return fresh;
}

describe('ProseMirror undo across an unload', () => {
  it('undoes and redoes what was typed before', () => {
    const before = editor(doc('hello'));
    before.type(6, ' world');
    before.type(12, '!');
    before.run(undo);

    const after = reopen(before.state);
    expect(undoDepth(after.state)).toBe(1);
    expect(redoDepth(after.state)).toBe(1);
    after.run(redo);
    expect(after.state.doc.textContent).toBe('hello world!');
    after.run(undo);
    after.run(undo);
    expect(after.state.doc.textContent).toBe('hello');
  });

  it('puts the selection back where the undone edit began', () => {
    const before = editor(doc('ab'));
    before.load(
      before.state.apply(
        before.state.tr.setSelection(TextSelection.create(before.state.doc, 2))
      )
    );
    before.type(2, 'X');
    const after = reopen(before.state);
    after.run(undo);
    expect(after.state.selection.from).toBe(2);
  });

  it('follows an edit made elsewhere while it was unloaded', () => {
    const before = editor(doc('one', 'two'));
    before.type(9, ' more');
    const changed = before.state.tr.insertText('zero ', 1).doc;

    const after = reopen(before.state, changed);
    after.run(undo);
    expect(after.state.doc.textContent).toBe('zero onetwo');
  });

  it('has nothing to restore when nothing was done', () => {
    const fresh = editor(doc('x'));
    expect(captureProseMirrorUndo(fresh.state)).toBeNull();
  });
});
