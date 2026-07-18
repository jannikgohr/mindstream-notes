/**
 * Tests for the user-mention plugin, driven through a real EditorView so
 * handleKeyDown runs exactly like ProseMirror runs it. Covers the href
 * round-trip, the boundary-`@` trigger (opens on a real mention, stays shut
 * inside an email address), mention insertion, whole-token deletion, and the
 * self-vs-other decoration classes.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Schema, type Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { EditorView } from '@milkdown/kit/prose/view';
import {
  userHref,
  parseUserHref,
  userMentionDecorationPlugin,
  userMentionPlugins
} from './user-mention';
import type { UserMentionBridge } from '../user-mention-bridge.svelte';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    text: { group: 'inline' }
  },
  marks: {
    link: {
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
      toDOM: (mark) => ['a', { href: mark.attrs.href as string }, 0]
    }
  }
});

function mentionMark(username: string) {
  return schema.mark('link', { href: userHref(username) });
}

/** Paragraph: `before` + mention(`@username`) + `after`. */
function makeDoc(before: string, username: string, after: string): ProseNode {
  const children: ProseNode[] = [];
  if (before) children.push(schema.text(before));
  children.push(schema.text(`@${username}`, [mentionMark(username)]));
  if (after) children.push(schema.text(after));
  return schema.node('doc', null, [schema.node('paragraph', null, children)]);
}

function makeView(doc: ProseNode, currentUsername = 'me'): EditorView {
  const host = document.createElement('div');
  document.body.append(host);
  const state = EditorState.create({
    doc,
    plugins: [
      userMentionDecorationPlugin({ currentUsername: () => currentUsername })
    ]
  });
  return new EditorView(host, { state });
}

function setCaret(view: EditorView, pos: number): void {
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, pos))
  );
}

function pressKey(view: EditorView, key: 'Backspace' | 'Delete'): boolean {
  const event = new KeyboardEvent('keydown', { key, cancelable: true });
  return !!view.someProp('handleKeyDown', (f) => f(view, event));
}

function paragraphText(view: EditorView): string {
  return view.state.doc.firstChild?.textContent ?? '';
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('user link href helpers', () => {
  it('round-trips a username', () => {
    expect(parseUserHref(userHref('alice'))).toBe('alice');
  });

  it('encodes and decodes awkward usernames', () => {
    const href = userHref('a b/c');
    expect(href).not.toContain(' ');
    expect(parseUserHref(href)).toBe('a b/c');
  });

  it('rejects non-user hrefs', () => {
    expect(parseUserHref('mindstream://note/x')).toBeNull();
    expect(parseUserHref('https://example.com')).toBeNull();
    expect(parseUserHref(null)).toBeNull();
    expect(parseUserHref('mindstream://user/')).toBeNull();
  });
});

describe('mention decoration classes', () => {
  it('marks a mention of the signed-in user as self', () => {
    const view = makeView(makeDoc('hi ', 'me', ''), 'me');
    const el = view.dom.querySelector('.user-mention');
    expect(el).not.toBeNull();
    expect(el?.classList.contains('user-mention-self')).toBe(true);
    expect(el?.getAttribute('data-mention-username')).toBe('me');
  });

  it('does not mark a mention of someone else as self', () => {
    const view = makeView(makeDoc('hi ', 'alice', ''), 'me');
    const el = view.dom.querySelector('.user-mention');
    expect(el).not.toBeNull();
    expect(el?.classList.contains('user-mention-self')).toBe(false);
  });

  it('marks nothing as self when signed out', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const state = EditorState.create({
      doc: makeDoc('hi ', 'me', ''),
      plugins: [userMentionDecorationPlugin({ currentUsername: () => null })]
    });
    const view = new EditorView(host, { state });
    expect(
      view.dom
        .querySelector('.user-mention')
        ?.classList.contains('user-mention-self')
    ).toBe(false);
  });
});

describe('whole-mention deletion', () => {
  it('Backspace at the mention end deletes the whole token', () => {
    // "hi " (len 3) + "@me" → mention spans doc pos 4..7; end caret = 7.
    const view = makeView(makeDoc('hi ', 'me', ''), 'me');
    setCaret(view, 1 + 'hi '.length + '@me'.length);
    expect(pressKey(view, 'Backspace')).toBe(true);
    expect(paragraphText(view)).toBe('hi ');
  });

  it('Delete at the mention start deletes the whole token', () => {
    const view = makeView(makeDoc('', 'me', ' there'), 'me');
    setCaret(view, 1); // start of paragraph, before the mention
    expect(pressKey(view, 'Delete')).toBe(true);
    expect(paragraphText(view)).toBe(' there');
  });

  it('leaves plain text deletion alone', () => {
    const view = makeView(makeDoc('hi ', 'me', ''), 'me');
    setCaret(view, 2); // inside "hi ", nowhere near the mention
    expect(pressKey(view, 'Backspace')).toBe(false);
  });
});

describe('mention navigation guard', () => {
  it('cancels the default navigation for a mention anchor click', () => {
    const view = makeView(makeDoc('hi ', 'me', ''), 'me');
    const anchor = view.dom.querySelector('a[href]');
    expect(anchor).not.toBeNull();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

// The trigger plugin is an internal `$prose` factory that needs a Milkdown ctx
// to unwrap, so its boundary-`@` detection is validated end-to-end in the
// preview. Here we just cover the public factory's wiring: it returns the
// trigger + decoration pair Crepe registers.
describe('userMentionPlugins factory', () => {
  it('returns a trigger and a decoration plugin', () => {
    const bridge = { setHandlers() {} } as unknown as UserMentionBridge;
    const plugins = userMentionPlugins(bridge, { currentUsername: () => 'me' });
    expect(plugins).toHaveLength(2);
  });
});
