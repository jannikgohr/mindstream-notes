/**
 * User mentions on the source surface — the user picker from
 * `../prose/user-mention.ts`, over raw markdown.
 *
 * Same trade as `./wikilink.ts`: the picker ports, the display concerns don't.
 * The prose plugin's decoration pass (styling a committed mention, highlighting
 * the one that names you) and its treat-a-mention-as-one-atomic-token deletion
 * both exist to make `[@alice](mindstream://user/alice)` look and behave like
 * `@alice`. On the source surface that markdown is the point, so what's left is
 * the affordance: typing `@` opens the user picker, committing writes the link.
 *
 * Same trigger rules, same popup component, same `editor.userMentions` setting
 * as the WYSIWYG pane. Candidates ("who can view this note") are resolved
 * asynchronously by the host and written to `bridge.state.users`, exactly as on
 * the prose side — this file never learns who they are.
 */

import type { EditorState, Extension } from '@codemirror/state';
import { userHref } from '../user-mention-href';
import type { UserMentionBridge } from '../user-mention-bridge.svelte';
import { inCodeContext } from './code-context';
import { escapeLinkText } from './link-text';
import { sourceTypeahead } from './typeahead';

/** Closes the menu on a runaway unclosed mention. */
const MAX_QUERY_LEN = 64;

/** How far back from the caret we scan for the opening `@`. */
const AUTO_OPEN_LOOKBACK = 80;

/**
 * Document position of the `@` whose query the caret sits in, else null.
 *
 * Aborts on whitespace because usernames contain none, and on brackets for the
 * same reason — the prose plugin's `validateOpen` rejects a query containing
 * either. Without the bracket rule `@[[Note` would satisfy this scan AND the
 * wikilink scan, opening both pickers on top of each other.
 *
 * The `@` only counts at a word boundary (whitespace before it, or start of
 * line) — that's what keeps the menu shut inside `email@domain`, and, usefully
 * here, inside the `[@alice](…)` a previous commit wrote, whose `@` is
 * preceded by `[`.
 *
 * Exported for tests.
 */
export function findMentionStart(
  state: EditorState,
  cursor: number
): number | null {
  if (inCodeContext(state, cursor)) return null;
  const line = state.doc.lineAt(cursor);
  const text = line.text;
  const offset = cursor - line.from;
  if (offset < 1) return null;

  const searchStart = Math.max(0, offset - AUTO_OPEN_LOOKBACK);
  for (let i = offset - 1; i >= searchStart; i--) {
    const c = text[i];
    if (/[\s[\]]/.test(c)) return null;
    if (c === '@') {
      if (i !== 0 && !/\s/.test(text[i - 1])) return null;
      const start = line.from + i;
      if (cursor - (start + 1) > MAX_QUERY_LEN) return null;
      return start;
    }
  }
  return null;
}

/**
 * End of the span a commit replaces: from the caret through the rest of the
 * `@name` word, so committing from the middle of one replaces the whole token
 * rather than leaving a suffix behind.
 *
 * Exported for tests.
 */
export function findMentionReplaceTo(
  state: EditorState,
  _start: number,
  cursor: number
): number {
  const line = state.doc.lineAt(cursor);
  const text = line.text;
  let i = cursor - line.from;
  while (i < text.length && !/\s/.test(text[i]) && text[i] !== '@') i++;
  return line.from + i;
}

/** The markdown a committed mention becomes — the same link the prose plugin
 *  builds as a mark, spelled out. */
function renderMentionLink(user: { username: string }): string {
  const username = user.username.trim();
  return `[@${escapeLinkText(username)}](${userHref(username)})`;
}

/**
 * The `@` user picker. Register only when the `editor.userMentions` setting is
 * on — the same toggle that gates the prose plugin — and pass the SOURCE
 * surface's bridge, not the WYSIWYG one (see `./typeahead`).
 */
export function sourceUserMention(bridge: UserMentionBridge): Extension {
  return sourceTypeahead({
    bridge,
    markerLength: 1,
    findStart: findMentionStart,
    findReplaceTo: findMentionReplaceTo,
    render: renderMentionLink
  });
}
