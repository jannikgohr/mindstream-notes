/**
 * Boundary-editing tests for the wikilink decoration plugin, driven
 * through a real EditorView so handleKeyDown / handleTextInput run
 * exactly like ProseMirror runs them: a key event first goes to the
 * plugin, and only if unhandled does the default behaviour (caret
 * move, `tr.insertText` with storedMarks) apply.
 *
 * Regression focus: editing at the end of a link's display name. The
 * caret enters editing via ArrowLeft, and every typed character must
 * keep the link mark and keep the boundary pinned — typing the second
 * character used to fall out of the link.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Schema, type Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { EditorView } from '@milkdown/kit/prose/view';
import { wikilinkDecorationPlugin, noteHref } from './wikilink';
import type { WikilinkBridge } from '../wikilink-bridge.svelte';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'inline*',
      toDOM: () => ['p', 0]
    },
    text: { group: 'inline' }
  },
  marks: {
    // Mirrors the commonmark link mark: non-inclusive, so typing at
    // the end of the marked range does not extend it by default —
    // that's exactly what the boundary-editing machinery works around.
    link: {
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
      toDOM: (mark) => ['a', { href: mark.attrs.href as string }, 0]
    }
  }
});

const linkMark = schema.mark('link', { href: noteHref('note-1') });

function makeDoc(before: string, title: string, after: string): ProseNode {
  const children: ProseNode[] = [];
  if (before) children.push(schema.text(before));
  children.push(schema.text(title, [linkMark]));
  if (after) children.push(schema.text(after));
  return schema.node('doc', null, [schema.node('paragraph', null, children)]);
}

const stubBridge = { cancel() {} } as unknown as WikilinkBridge;

function makeView(doc: ProseNode): EditorView {
  const host = document.createElement('div');
  document.body.append(host);
  const state = EditorState.create({
    doc,
    plugins: [
      wikilinkDecorationPlugin(stubBridge, { openOnClick: () => false })
    ]
  });
  return new EditorView(host, { state });
}

function setCaret(view: EditorView, pos: number): void {
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, pos))
  );
}

/** Dispatch a keydown the way ProseMirror does: plugin first, then the
 *  default behaviour (for arrows: a plain caret move that clears
 *  storedMarks — which is what `tr.setSelection` does). */
function pressKey(view: EditorView, key: 'ArrowLeft' | 'ArrowRight'): void {
  const event = new KeyboardEvent('keydown', { key, cancelable: true });
  const handled = view.someProp('handleKeyDown', (f) => f(view, event));
  if (handled || event.defaultPrevented) return;
  const pos = view.state.selection.from + (key === 'ArrowRight' ? 1 : -1);
  setCaret(view, pos);
}

/** Type text the way ProseMirror does: handleTextInput first, then the
 *  default `tr.insertText` (which honours storedMarks). */
function typeText(view: EditorView, text: string): void {
  for (const char of text) {
    const { from, to } = view.state.selection;
    const deflt = () => view.state.tr.insertText(char, from, to);
    const handled = view.someProp('handleTextInput', (f) =>
      f(view, from, to, char, deflt)
    );
    if (!handled) {
      view.dispatch(deflt());
    }
  }
}

/** The text carrying the link mark, concatenated in doc order. */
function linkedText(view: EditorView): string {
  let out = '';
  view.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((m) => m.type.name === 'link')) {
      out += node.text;
    }
  });
  return out;
}

function paragraphText(view: EditorView): string {
  return view.state.doc.firstChild?.textContent ?? '';
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('wikilink boundary editing at the end of the display name', () => {
  // Doc: "ab" + link("Title") + "cd" → link text spans pos 3..8.
  const LINK_END = 1 + 2 + 'Title'.length; // = 8

  function enterEndEditing(): EditorView {
    const view = makeView(makeDoc('ab', 'Title', 'cd'));
    setCaret(view, LINK_END);
    // ArrowLeft at the trailing boundary opts into link-text editing.
    pressKey(view, 'ArrowLeft');
    expect(view.dom.dataset.wikilinkBoundary).toBe('inside');
    expect(view.dom.dataset.wikilinkBoundarySide).toBe('end');
    return view;
  }

  it('keeps the first typed character inside the link', () => {
    const view = enterEndEditing();
    typeText(view, 'x');
    expect(linkedText(view)).toBe('Titlex');
    expect(paragraphText(view)).toBe('abTitlexcd');
    expect(view.dom.dataset.wikilinkBoundary).toBe('inside');
  });

  it('keeps the second typed character inside the link (regression)', () => {
    const view = enterEndEditing();
    typeText(view, 'xy');
    expect(linkedText(view)).toBe('Titlexy');
    expect(paragraphText(view)).toBe('abTitlexycd');
    expect(view.dom.dataset.wikilinkBoundary).toBe('inside');
  });

  it('keeps a longer burst of typing inside the link', () => {
    const view = enterEndEditing();
    typeText(view, ' renamed');
    expect(linkedText(view)).toBe('Title renamed');
    expect(view.dom.dataset.wikilinkBoundary).toBe('inside');
  });

  it('stays in editing mode when the caret reaches the end from inside', () => {
    const view = makeView(makeDoc('ab', 'Title', 'cd'));
    // Caret inside the display name, one character before its end —
    // the position an ArrowRight away from the boundary.
    setCaret(view, LINK_END - 1);
    typeText(view, 'x'); // plain typing inside the link text
    expect(linkedText(view)).toBe('Titlxe');
    // Move to the very end of the display name with the arrow key…
    pressKey(view, 'ArrowRight');
    expect(view.state.selection.from).toBe(LINK_END + 1);
    // …and keep typing: the characters must stay part of the link.
    typeText(view, 'yz');
    expect(linkedText(view)).toBe('Titlxeyz');
    expect(view.dom.dataset.wikilinkBoundary).toBe('inside');
  });

  it('ArrowRight at the boundary exits editing and types outside', () => {
    const view = enterEndEditing();
    pressKey(view, 'ArrowRight');
    expect(view.dom.dataset.wikilinkBoundary).toBe('outside');
    typeText(view, 'q');
    expect(linkedText(view)).toBe('Title');
    expect(paragraphText(view)).toBe('abTitleqcd');
  });
});

describe('wikilink boundary editing at the start of the display name', () => {
  const LINK_START = 1 + 2; // = 3

  it('ArrowRight at the leading boundary enters editing and typing stays inside', () => {
    const view = makeView(makeDoc('ab', 'Title', 'cd'));
    setCaret(view, LINK_START);
    pressKey(view, 'ArrowRight');
    expect(view.dom.dataset.wikilinkBoundary).toBe('inside');
    expect(view.dom.dataset.wikilinkBoundarySide).toBe('start');
    typeText(view, 'xy');
    expect(linkedText(view)).toBe('xyTitle');
  });
});

describe('note-link navigation guard', () => {
  // On the Android WebView, following a `mindstream://note/…` anchor
  // white-screens the app. The capture-phase guard must cancel the
  // default navigation for note-link clicks regardless of whether the
  // note is opened.
  it('cancels the default navigation for a note-link anchor click', () => {
    const view = makeView(makeDoc('ab', 'Title', 'cd'));
    const anchor = view.dom.querySelector('a[href]');
    expect(anchor).not.toBeNull();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves clicks that miss a note link navigable', () => {
    const view = makeView(makeDoc('ab', 'Title', 'cd'));
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
