/**
 * The `@` user picker on the source surface. Same two layers as
 * `./wikilink.test.ts`: the scan rules are pure and tested directly, the menu
 * and commit paths run through a real EditorView.
 */

import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { createUserMentionBridge } from '../user-mention-bridge.svelte';
import { findWikilinkStart } from './wikilink';
import {
  findMentionReplaceTo,
  findMentionStart,
  sourceUserMention
} from './user-mention';

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
  return findMentionStart(state, cursor);
}

describe('findMentionStart', () => {
  it('opens on `@` at the start of a line', () => {
    expect(startOf('@|')).toBe(0);
    expect(startOf('@ali|')).toBe(0);
  });

  it('opens on `@` after whitespace', () => {
    expect(startOf('hi @ali|')).toBe(3);
  });

  it('stays shut inside an email address', () => {
    // The whole point of the word-boundary rule.
    expect(startOf('mail@exam|')).toBeNull();
  });

  it('stays shut inside a mention it already committed', () => {
    // The `@` is preceded by `[`, not whitespace — which is what stops the
    // menu reopening over a finished link.
    expect(startOf('[@ali|ce](mindstream://user/alice)')).toBeNull();
  });

  it('stays shut inside the href of a committed mention', () => {
    expect(startOf('[@alice](mindstream://user/ali|ce)')).toBeNull();
  });

  it('aborts on whitespace in the query — usernames have none', () => {
    expect(startOf('@alice bob|')).toBeNull();
  });

  it('aborts on a bracket so it cannot double-trigger with wikilinks', () => {
    // `@[[Note` otherwise satisfies this scan and the wikilink scan at once,
    // stacking two pickers.
    expect(startOf('@[[No|')).toBeNull();
    expect(startOf('@]x|')).toBeNull();
  });

  it('does not scan across a line break', () => {
    expect(startOf('@alice\nbob|')).toBeNull();
  });

  it('does not open with the caret before the `@`', () => {
    expect(startOf('|@alice')).toBeNull();
  });

  it('closes on a runaway query past the length cap', () => {
    expect(startOf(`@${'x'.repeat(64)}|`)).toBe(0);
    expect(startOf(`@${'x'.repeat(65)}|`)).toBeNull();
  });

  it('stays shut inside a fenced code block', () => {
    expect(startOf('```js\n// @ali|\n```')).toBeNull();
  });

  it('stays shut inside an inline code span', () => {
    expect(startOf('use `@ali|` here')).toBeNull();
  });
});

describe('mention and wikilink triggers are mutually exclusive', () => {
  // Both pickers share one editor and each renders its own popup, so any input
  // where both scans match would stack two menus. Neither scan may be relaxed
  // without re-checking this.
  const cases = ['@[[No|', '[[@ali|', '[[No|', '@ali|', '[[@|', '@[|'];
  for (const marked of cases) {
    it(`at most one fires for ${JSON.stringify(marked.replace('|', ''))}`, () => {
      const { state, cursor } = stateOf(marked);
      const fired = [
        findMentionStart(state, cursor),
        findWikilinkStart(state, cursor)
      ].filter((v) => v !== null);
      expect(fired.length).toBeLessThanOrEqual(1);
    });
  }
});

describe('findMentionReplaceTo', () => {
  it('extends through the rest of the word', () => {
    const { state, cursor } = stateOf('@ali|ce');
    // '@alice' is 6 chars → replace through its end.
    expect(findMentionReplaceTo(state, 0, cursor)).toBe(6);
  });

  it('stops at whitespace', () => {
    const { state, cursor } = stateOf('@ali|ce there');
    expect(findMentionReplaceTo(state, 0, cursor)).toBe(6);
  });

  it('stops at the next `@`', () => {
    const { state, cursor } = stateOf('@ali|ce@bob');
    expect(findMentionReplaceTo(state, 0, cursor)).toBe(6);
  });

  it('stops at the end of the line', () => {
    const { state, cursor } = stateOf('@ali|ce\nnext');
    expect(findMentionReplaceTo(state, 0, cursor)).toBe(6);
  });
});

/* --- Menu + commit -------------------------------------------------------- */

function viewTyping(text: string) {
  const bridge = createUserMentionBridge();
  const view = new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: [markdown(), sourceUserMention(bridge)]
    })
  });
  view.dispatch({
    changes: { from: 0, insert: text },
    selection: EditorSelection.cursor(text.length)
  });
  return { bridge, view };
}

describe('sourceUserMention', () => {
  it('opens on `@` and publishes the query', () => {
    const { bridge } = viewTyping('hi @ali');
    expect(bridge.state.open).toBe(true);
    expect(bridge.state.query).toBe('ali');
  });

  it('stays shut on an email address', () => {
    const { bridge } = viewTyping('mail@example');
    expect(bridge.state.open).toBe(false);
  });

  it('replaces the trigger with a username-backed markdown link', () => {
    const { bridge, view } = viewTyping('hi @ali');
    bridge.insert({ username: 'alice' });
    expect(view.state.doc.toString()).toBe(
      'hi [@alice](mindstream://user/alice)'
    );
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  it('replaces the whole word when committing from the middle', () => {
    const { bridge, view } = viewTyping('@alicexx');
    view.dispatch({ selection: EditorSelection.cursor(4) });
    bridge.insert({ username: 'alice' });
    expect(view.state.doc.toString()).toBe('[@alice](mindstream://user/alice)');
  });

  it('leaves the rest of the line alone', () => {
    const { bridge, view } = viewTyping('hi @ali there');
    view.dispatch({ selection: EditorSelection.cursor(7) });
    bridge.insert({ username: 'alice' });
    expect(view.state.doc.toString()).toBe(
      'hi [@alice](mindstream://user/alice) there'
    );
  });

  it('does not re-trigger on the mention it just wrote', () => {
    const { bridge, view } = viewTyping('hi @ali');
    bridge.insert({ username: 'alice' });
    expect(bridge.state.open).toBe(false);
    expect(findMentionStart(view.state, view.state.doc.length)).toBeNull();
  });

  it('escapes a username that would otherwise break the link', () => {
    const { bridge, view } = viewTyping('@x');
    bridge.insert({ username: 'a]b' });
    expect(view.state.doc.toString()).toBe('[@a\\]b](mindstream://user/a%5Db)');
  });

  it('ignores a commit with no trigger open', () => {
    const { bridge, view } = viewTyping('plain text');
    bridge.insert({ username: 'alice' });
    expect(view.state.doc.toString()).toBe('plain text');
  });
});
