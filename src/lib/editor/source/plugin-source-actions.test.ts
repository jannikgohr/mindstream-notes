import { describe, expect, it, vi } from 'vitest';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { applyPluginSourceEdit } from './plugin-source-actions';

// A headless stand-in for EditorView: real EditorState transactions (so
// document + selection math is exercised for real), a captured dispatch, and a
// no-op focus. Avoids the DOM an actual EditorView would require.
function makeView(doc: string, from: number, to = from) {
  let state = EditorState.create({
    doc,
    selection: { anchor: from, head: to }
  });
  const focus = vi.fn();
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
    focus
  };
  return {
    view: view as unknown as EditorView,
    focus,
    text: () => state.doc.toString(),
    sel: () => state.selection.main
  };
}

describe('applyPluginSourceEdit', () => {
  it('inserts text and places the caret at the default (end) offset', () => {
    const h = makeView('hello world', 5, 5);
    applyPluginSourceEdit(h.view, { type: 'insertText', text: ' there' });
    expect(h.text()).toBe('hello there world');
    expect(h.sel().anchor).toBe(11); // 5 + ' there'.length
    expect(h.focus).toHaveBeenCalled();
  });

  it('honours an explicit (clamped) cursorOffset', () => {
    const h = makeView('', 0, 0);
    applyPluginSourceEdit(h.view, {
      type: 'insertText',
      text: '**',
      cursorOffset: 1
    });
    expect(h.text()).toBe('**');
    expect(h.sel().anchor).toBe(1);
  });

  it('clamps an out-of-range cursorOffset into the inserted text', () => {
    const h = makeView('', 0, 0);
    applyPluginSourceEdit(h.view, {
      type: 'insertText',
      text: 'ab',
      cursorOffset: 999
    });
    expect(h.sel().anchor).toBe(2);
  });

  it('wraps the current selection, selecting the wrapped inner text', () => {
    const h = makeView('say bold now', 4, 8); // selects "bold"
    applyPluginSourceEdit(h.view, {
      type: 'wrapSelection',
      before: '**',
      after: '**'
    });
    expect(h.text()).toBe('say **bold** now');
    // Inner selection is the original text, now offset past the "before".
    expect(h.sel().from).toBe(6);
    expect(h.sel().to).toBe(10);
  });

  it('wraps using the placeholder when nothing is selected', () => {
    const h = makeView('x ', 2, 2);
    applyPluginSourceEdit(h.view, {
      type: 'wrapSelection',
      before: '[',
      after: ']',
      placeholder: 'link'
    });
    expect(h.text()).toBe('x [link]');
    expect(h.sel().from).toBe(3);
    expect(h.sel().to).toBe(7);
  });
});
