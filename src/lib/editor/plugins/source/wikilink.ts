/**
 * Wikilinks on the source surface — the note picker from `../prose/wikilink.ts`,
 * over raw markdown.
 *
 * Deliberately just the picker. The prose plugin's other two concerns don't
 * belong here: decorating an ID-backed link so it READS as `[[Title]]`, and the
 * boundary-editing state machine that makes that decoration feel like text,
 * both exist to hide the markdown. Hiding the markdown is the opposite of what
 * the source surface is for — here `[Title](mindstream://note/<id>)` is meant
 * to be visible and directly editable, and `@codemirror/lang-markdown` already
 * highlights it as a link.
 *
 * So what's left is the affordance that isn't about display at all: typing
 * `[[` opens the note picker, and committing writes the link. Same trigger,
 * same popup component, same `editor.wikilinks` setting as the WYSIWYG pane.
 *
 * The scanning rules mirror `findEnclosingWikilinkStart` / `findInsertionReplaceTo`
 * in the prose plugin, with one simplification: those work in parent-relative
 * offsets to avoid reading across a block boundary, whereas here a line is the
 * natural bound and `\n` is a real character we can't scan past by accident.
 */

import type { EditorState, Extension } from '@codemirror/state';
import { noteHref } from '../wikilink-href';
import type { WikilinkBridge } from '../wikilink-bridge.svelte';
import { inCodeContext } from './code-context';
import { escapeLinkText } from './link-text';
import { sourceTypeahead } from './typeahead';

/** Closes the menu on a runaway "I forgot to close my brackets". */
const MAX_QUERY_LEN = 80;

/** How far back from the caret we scan for the opening `[[`. Wikilink titles
 *  aren't long, and this caps the cost of the scan that runs on every update. */
const AUTO_OPEN_LOOKBACK = 200;

/**
 * Document position of the `[[` whose query the caret sits in, else null.
 *
 * The scan is one-directional and does NOT require a closing `]]` — typing
 * `[[` with nothing after it yet is the original trigger. It aborts on `]`
 * because a valid wikilink's interior has no brackets, so meeting one going
 * backwards means we've stepped out the far side of a closed link.
 *
 * Exported for tests.
 */
export function findWikilinkStart(
  state: EditorState,
  cursor: number
): number | null {
  if (inCodeContext(state, cursor)) return null;
  const line = state.doc.lineAt(cursor);
  const text = line.text;
  const offset = cursor - line.from;
  if (offset < 2) return null;

  // From 1, not 0: the loop reads text[i - 1] looking for the second `[`.
  const searchStart = Math.max(1, offset - AUTO_OPEN_LOOKBACK);
  for (let i = offset - 1; i >= searchStart; i--) {
    const c = text[i];
    if (c === ']') return null;
    if (c === '[' && text[i - 1] === '[') {
      const start = line.from + (i - 1);
      // The lookback window is wider than the query cap, so this still has to
      // be checked separately.
      if (cursor - (start + 2) > MAX_QUERY_LEN) return null;
      return start;
    }
  }
  return null;
}

/**
 * End of the span a commit replaces. When the caret is inside an already-
 * complete `[[Title]]`, that's the whole thing — otherwise committing from the
 * middle would leave the tail behind (`[Note](…) Note]]`).
 *
 * Exported for tests.
 */
export function findWikilinkReplaceTo(
  state: EditorState,
  start: number,
  cursor: number
): number {
  const line = state.doc.lineAt(cursor);
  if (start < line.from) return cursor;
  const text = line.text;
  if (text.slice(start - line.from, start - line.from + 2) !== '[[') {
    return cursor;
  }
  for (let i = cursor - line.from; i < text.length; i++) {
    const c = text[i];
    if (c === '[') return cursor;
    if (c === ']') return text[i + 1] === ']' ? line.from + i + 2 : cursor;
  }
  return cursor;
}

/** The markdown a committed note becomes — the same ID-backed link the prose
 *  plugin builds as a mark, spelled out. */
function renderNoteLink(note: { id: string; title: string }): string {
  const label = escapeLinkText(note.title.trim() || 'Untitled');
  return `[${label}](${noteHref(note.id)})`;
}

/**
 * The `[[` note picker. Register only when the `editor.wikilinks` setting is
 * on — the same toggle that gates the prose plugin — and pass the SOURCE
 * surface's bridge, not the WYSIWYG one (see `./typeahead`).
 */
export function sourceWikilink(bridge: WikilinkBridge): Extension {
  return sourceTypeahead({
    bridge,
    markerLength: 2,
    findStart: findWikilinkStart,
    findReplaceTo: findWikilinkReplaceTo,
    render: renderNoteLink
  });
}
