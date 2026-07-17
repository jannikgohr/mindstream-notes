/**
 * The `[[` note picker on the source surface.
 *
 * Two layers:
 *   - The scan rules (`findWikilinkStart` / `findWikilinkReplaceTo`) are pure
 *     over an `EditorState` and tested directly.
 *   - Opening the menu and committing are driven through a real EditorView,
 *     because that's what wires the bridge handlers and what the popup calls.
 *     It also covers the state field, which only computes on a transaction.
 *
 * `bridge.state.caretRect` is deliberately not asserted: it's published from
 * the measure cycle and needs real layout, which happy-dom doesn't do. Popup
 * positioning is an e2e concern.
 */

import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { createWikilinkBridge } from '../wikilink-bridge.svelte';
import {
  findWikilinkReplaceTo,
  findWikilinkStart,
  sourceWikilink
} from './wikilink';

/** Build a state from a doc with `|` marking the caret; returns the state and
 *  the caret position with the marker stripped. */
function stateOf(marked: string): { state: EditorState; cursor: number } {
  const cursor = marked.indexOf('|');
  return {
    state: EditorState.create({
      doc: marked.replace('|', ''),
      selection: EditorSelection.cursor(cursor),
      extensions: [markdown()]
    }),
    cursor
  };
}

function startOf(marked: string): number | null {
  const { state, cursor } = stateOf(marked);
  return findWikilinkStart(state, cursor);
}

describe('findWikilinkStart', () => {
  it('opens on a bare `[[`', () => {
    expect(startOf('[[|')).toBe(0);
  });

  it('opens with a query typed after the brackets', () => {
    expect(startOf('[[Note Ti|')).toBe(0);
    expect(startOf('text [[Note Ti|')).toBe(5);
  });

  it('opens from inside an already-closed [[Title]]', () => {
    // Clicking into an existing wikilink re-offers the picker, which is how
    // the user re-targets a link without retyping the brackets.
    expect(startOf('[[Note Ti|tle]]')).toBe(0);
  });

  it('does not open before the second bracket is typed', () => {
    expect(startOf('[|')).toBeNull();
    expect(startOf('|')).toBeNull();
  });

  it('does not open on a single bracket with a query', () => {
    expect(startOf('[Note|')).toBeNull();
  });

  it('aborts on a `]` between the brackets and the caret', () => {
    // The caret is past a closed link, not inside an open one.
    expect(startOf('[[Note]] |')).toBeNull();
  });

  it('anchors to the nearest `[[` when a line has two', () => {
    expect(startOf('[[one]] [[tw|')).toBe(8);
  });

  it('does not scan across a line break', () => {
    expect(startOf('[[\nquery|')).toBeNull();
  });

  it('closes on a runaway query past the length cap', () => {
    expect(startOf(`[[${'x'.repeat(80)}|`)).toBe(0);
    expect(startOf(`[[${'x'.repeat(81)}|`)).toBeNull();
  });

  it('stays shut inside a fenced code block', () => {
    expect(startOf('```js\nconst a = arr[[i|\n```')).toBeNull();
  });

  it('stays shut inside an inline code span', () => {
    expect(startOf('use `arr[[i|` here')).toBeNull();
  });
});

describe('findWikilinkReplaceTo', () => {
  it('extends through a closing `]]` so no tail is left behind', () => {
    const { state, cursor } = stateOf('[[Note Ti|tle]]');
    // '[[Note Title]]' is 14 chars → replace through the final bracket.
    expect(findWikilinkReplaceTo(state, 0, cursor)).toBe(14);
  });

  it('stops at the caret when the link is still unclosed', () => {
    const { state, cursor } = stateOf('[[Note Ti|');
    expect(findWikilinkReplaceTo(state, 0, cursor)).toBe(cursor);
  });

  it('stops at the caret when the next thing is another `[`', () => {
    const { state, cursor } = stateOf('[[Note Ti| [[other]]');
    expect(findWikilinkReplaceTo(state, 0, cursor)).toBe(cursor);
  });

  it('stops at the caret on a lone `]`', () => {
    const { state, cursor } = stateOf('[[Note Ti|tle] x');
    expect(findWikilinkReplaceTo(state, 0, cursor)).toBe(cursor);
  });
});

/* --- Commit path ---------------------------------------------------------- */

/** A view with the plugin installed, whose document is built by a transaction
 *  — the state field computes the trigger on update, not on create. */
function viewTyping(text: string) {
  const bridge = createWikilinkBridge();
  const view = new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: [markdown(), sourceWikilink(bridge)]
    })
  });
  view.dispatch({
    changes: { from: 0, insert: text },
    selection: EditorSelection.cursor(text.length)
  });
  return { bridge, view };
}

describe('sourceWikilink menu', () => {
  it('opens on `[[` and publishes the query as the user types', () => {
    const { bridge, view } = viewTyping('[[');
    expect(bridge.state.open).toBe(true);
    expect(bridge.state.query).toBe('');

    view.dispatch({
      changes: { from: 2, insert: 'No' },
      selection: EditorSelection.cursor(4)
    });
    expect(bridge.state.query).toBe('No');
  });

  it('stays shut on ordinary text', () => {
    const { bridge } = viewTyping('just prose');
    expect(bridge.state.open).toBe(false);
  });

  it('closes when the caret leaves the trigger', () => {
    const { bridge, view } = viewTyping('[[No');
    expect(bridge.state.open).toBe(true);
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(bridge.state.open).toBe(false);
  });

  it('closes on cancel and stays shut while the caret remains inside', () => {
    const { bridge, view } = viewTyping('[[No');
    bridge.cancel();
    expect(bridge.state.open).toBe(false);

    // Escape means "not for this link" — typing more of the query must not
    // resurrect the menu the very next keystroke.
    view.dispatch({
      changes: { from: 4, insert: 't' },
      selection: EditorSelection.cursor(5)
    });
    expect(bridge.state.open).toBe(false);
  });

  it('re-arms once the caret leaves the dismissed trigger', () => {
    const { bridge, view } = viewTyping('[[No');
    bridge.cancel();
    view.dispatch({ selection: EditorSelection.cursor(0) });
    view.dispatch({ selection: EditorSelection.cursor(4) });
    expect(bridge.state.open).toBe(true);
  });

  it('resets the highlight when the query changes', () => {
    const { bridge, view } = viewTyping('[[No');
    bridge.state.highlight = 3;
    view.dispatch({
      changes: { from: 4, insert: 't' },
      selection: EditorSelection.cursor(5)
    });
    expect(bridge.state.highlight).toBe(0);
  });

  it('keeps the highlight across an update that leaves the query alone', () => {
    const { bridge, view } = viewTyping('[[No');
    bridge.state.highlight = 2;
    // A no-op transaction, standing in for the churn of a remote edit or a
    // resize — arrow-key navigation must survive it.
    view.dispatch({});
    expect(bridge.state.highlight).toBe(2);
  });
});

describe('sourceWikilink commit', () => {
  it('replaces the trigger span with an ID-backed markdown link', () => {
    const { bridge, view } = viewTyping('[[No');
    bridge.insert({ id: 'note-1', title: 'Notes' });
    expect(view.state.doc.toString()).toBe('[Notes](mindstream://note/note-1)');
    // Caret lands after the inserted link, ready to keep typing.
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  it('keeps the surrounding text intact', () => {
    const { bridge, view } = viewTyping('see [[No');
    bridge.insert({ id: 'note-1', title: 'Notes' });
    expect(view.state.doc.toString()).toBe(
      'see [Notes](mindstream://note/note-1)'
    );
  });

  it('swallows a closing `]]` instead of leaving it behind', () => {
    const { bridge, view } = viewTyping('[[No]]');
    // Caret sits between `No` and `]]`, as auto-pair would leave it.
    view.dispatch({ selection: EditorSelection.cursor(4) });
    bridge.insert({ id: 'note-1', title: 'Notes' });
    expect(view.state.doc.toString()).toBe('[Notes](mindstream://note/note-1)');
  });

  it('escapes brackets in a title so the link does not break', () => {
    const { bridge, view } = viewTyping('[[Fo');
    bridge.insert({ id: 'note-1', title: 'Foo [bar]' });
    expect(view.state.doc.toString()).toBe(
      '[Foo \\[bar\\]](mindstream://note/note-1)'
    );
  });

  it('percent-encodes an id whose parens would end the link early', () => {
    // encodeURIComponent leaves `)` alone — see `../link-url`. Unescaped, it
    // would terminate the destination and spill `c)` into the document.
    const { bridge, view } = viewTyping('[[Fo');
    bridge.insert({ id: 'a b)c', title: 'Foo' });
    expect(view.state.doc.toString()).toBe(
      '[Foo](mindstream://note/a%20b%29c)'
    );
  });

  it('falls back to Untitled for a blank title', () => {
    const { bridge, view } = viewTyping('[[');
    bridge.insert({ id: 'note-1', title: '   ' });
    expect(view.state.doc.toString()).toBe(
      '[Untitled](mindstream://note/note-1)'
    );
  });

  it('does not re-trigger on the link it just wrote', () => {
    const { bridge, view } = viewTyping('[[No');
    bridge.insert({ id: 'note-1', title: 'Notes' });
    expect(bridge.state.open).toBe(false);
    // The caret now sits after `…note-1)`; nothing about that text should
    // read as an open trigger.
    expect(findWikilinkStart(view.state, view.state.doc.length)).toBeNull();
  });

  it('ignores a commit with no trigger open', () => {
    const { bridge, view } = viewTyping('plain text');
    bridge.insert({ id: 'note-1', title: 'Notes' });
    expect(view.state.doc.toString()).toBe('plain text');
  });
});
