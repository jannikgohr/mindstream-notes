/**
 * User mentions — `@username` editing affordances backed by standard markdown
 * links: `[@username](mindstream://user/<username>)`.
 *
 * A trimmed sibling of `./wikilink.ts`. Same three concerns (trigger,
 * decoration, bridge) but simpler: a committed mention is a short, atomic
 * token, so we skip wikilink's character-by-character boundary-editing state
 * machine. What we keep:
 *
 *   1. **Trigger plugin** — detects `@` typed at a word boundary, opens a
 *      menu via the per-editor `UserMentionBridge`, tracks the query span
 *      (text between `@` and the cursor), and intercepts Arrow / Enter / Tab /
 *      Esc while open. The `@` must be preceded by whitespace or start-of-block
 *      so `email@domain` never triggers, and the query aborts on whitespace
 *      because usernames contain none.
 *
 *   2. **Decoration plugin** — decorates text carrying a `mindstream://user/`
 *      link mark with `.user-mention`, plus `.user-mention-self` when the
 *      mention names the signed-in user. Plain Backspace/Delete adjacent to a
 *      mention removes the whole token. Mentions never navigate (there is no
 *      real URL behind them), so a capture-phase guard cancels any anchor
 *      default and the stock link tooltip is suppressed.
 *
 * The "who is signed in" and "who can view this note" facts both live outside
 * the plugin: `currentUsername` is injected via options (a getter, like
 * wikilink's `openOnClick`), and the candidate list is fed to the bridge by
 * `NoteEditor`. That keeps this file unit-testable against a bare ProseMirror
 * view.
 */

import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState
} from '@milkdown/kit/prose/state';
import type { Mark } from '@milkdown/kit/prose/model';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { parseUserHref, userHref } from '../user-mention-href';
import type { UserMentionBridge } from '../user-mention-bridge.svelte';

// Re-export so consumers can reach everything mention-related through this one
// module — the bridge factory lives in its own `.svelte.ts` (Svelte reserves
// the `$` prefix there, which would block this file's `$prose` import).
export type { UserMentionBridge } from '../user-mention-bridge.svelte';
export { createUserMentionBridge } from '../user-mention-bridge.svelte';

/* --- User link resolution -------------------------------------------------- */

// Shared with the source-mode plugin — see `../user-mention-href`. Re-exported
// so mention consumers can still reach everything through this module.
export { parseUserHref, userHref } from '../user-mention-href';

export interface UserMentionPluginOptions {
  /** The signed-in user's username, or null when signed out. */
  currentUsername: () => string | null;
}

/* --- Trigger plugin -------------------------------------------------------- */

interface TriggerState {
  /** Doc position of the `@`. Null when the menu is closed. */
  startPos: number | null;
}

const triggerPluginKey = new PluginKey<TriggerState>(
  'mindstream-user-mention-trigger'
);

/** Closes the menu on an absurdly long query — a runaway unclosed mention. */
const MAX_QUERY_LEN = 64;

/** How far back from the cursor we scan for the opening `@`. */
const AUTO_OPEN_LOOKBACK = 80;

/** Parent node types where `@` is literal, never mention syntax. */
const NON_MENTION_PARENTS = new Set(['code_block', 'fence', 'html_block']);

/** True when the character before `startPos` is whitespace or start-of-block —
 *  what separates a real mention from an `email@domain` fragment. */
function mentionStartIsBoundary(state: EditorState, startPos: number): boolean {
  const $pos = state.doc.resolve(startPos);
  if (!$pos.parent.isTextblock) return false;
  const offset = startPos - $pos.start();
  if (offset <= 0) return true;
  const text = $pos.parent.textBetween(0, $pos.parent.content.size, '\n', '\n');
  return /\s/.test(text[offset - 1]);
}

/**
 * If the cursor sits inside (or right after) an `@…` word in the current text
 * block, return the doc position of the `@`; otherwise `null`. Powers both the
 * "user typed `@`" case and clicking into an already-typed `@name`.
 *
 * Scans backwards from the cursor, aborting on whitespace / `\n` (usernames
 * have none) or a stray `@`. The `@` only counts when it sits at a word
 * boundary — that's what keeps the menu shut inside email addresses.
 */
function findEnclosingMentionStart(state: EditorState): number | null {
  const sel = state.selection;
  if (!sel.empty) return null;
  const $from = sel.$from;
  if (!$from.parent.isTextblock) return null;
  if (NON_MENTION_PARENTS.has($from.parent.type.name)) return null;
  const codeMark = state.schema.marks.code;
  if (codeMark && codeMark.isInSet($from.marks())) return null;

  const offset = $from.parentOffset;
  if (offset < 1) return null;

  const parentText = $from.parent.textBetween(
    0,
    $from.parent.content.size,
    '\n',
    '\n'
  );
  const searchStart = Math.max(0, offset - AUTO_OPEN_LOOKBACK);
  for (let i = offset - 1; i >= searchStart; i--) {
    const c = parentText[i];
    if (c === '\n' || /\s/.test(c)) return null;
    if (c === '@') {
      const boundary = i === 0 || /\s/.test(parentText[i - 1]);
      return boundary ? $from.start() + i : null;
    }
  }
  return null;
}

/** Bounds check for keeping an open menu open through a transaction. */
function validateOpen(startPos: number, state: EditorState): boolean {
  const cursor = state.selection.from;
  if (cursor < startPos + 1) return false;
  if (state.doc.resolve(startPos).parent !== state.doc.resolve(cursor).parent) {
    return false;
  }
  if (!mentionStartIsBoundary(state, startPos)) return false;
  const queryRaw = state.doc.textBetween(startPos + 1, cursor, '\n');
  if (/[\s@[\]\n]/.test(queryRaw)) return false;
  return queryRaw.length <= MAX_QUERY_LEN;
}

/**
 * Commit target: extend from the cursor through the rest of the `@name` word so
 * committing from the middle of an existing mention replaces the whole token
 * rather than leaving a suffix behind.
 */
function findMentionReplaceTo(state: EditorState, cursor: number): number {
  const $cursor = state.doc.resolve(cursor);
  if (!$cursor.parent.isTextblock) return cursor;
  const parentStart = $cursor.start();
  const text = $cursor.parent.textBetween(
    0,
    $cursor.parent.content.size,
    '\n',
    '\n'
  );
  let i = cursor - parentStart;
  while (i < text.length && !/\s/.test(text[i]) && text[i] !== '@') i++;
  return parentStart + i;
}

function userMentionTriggerPlugin(
  bridge: UserMentionBridge
): Plugin<TriggerState> {
  let viewRef: EditorView | null = null;

  function resetBridgeState() {
    bridge.state.open = false;
    bridge.state.query = '';
    bridge.state.caretRect = null;
    bridge.state.highlight = 0;
  }

  function close() {
    resetBridgeState();
    if (viewRef) {
      viewRef.dispatch(
        viewRef.state.tr.setMeta(triggerPluginKey, { close: true })
      );
    }
  }

  function insert(user: { username: string }) {
    if (!viewRef) return;
    const view = viewRef;
    const trigger = triggerPluginKey.getState(view.state);
    const start = trigger?.startPos ?? null;
    if (start === null) {
      close();
      return;
    }
    const cursor = view.state.selection.from;
    const replaceTo = findMentionReplaceTo(view.state, cursor);
    const username = user.username.trim();
    if (!username) {
      close();
      return;
    }
    const label = `@${username}`;
    const linkType = view.state.schema.marks.link;
    if (!linkType) {
      const tr = view.state.tr.insertText(label, start, replaceTo);
      tr.setMeta(triggerPluginKey, { close: true });
      view.dispatch(tr);
      view.focus();
      close();
      return;
    }
    const linkMark = linkType.create({ href: userHref(username), title: null });
    const linkText = view.state.schema.text(label, [linkMark]);
    const tr = view.state.tr.replaceWith(start, replaceTo, linkText);
    tr.setSelection(TextSelection.create(tr.doc, start + label.length));
    tr.setStoredMarks([]);
    tr.setMeta(triggerPluginKey, { close: true });
    view.dispatch(tr);
    view.focus();
    close();
  }

  bridge.setHandlers({ insert, cancel: close });

  return new Plugin<TriggerState>({
    key: triggerPluginKey,

    state: {
      init: () => ({ startPos: null }),
      apply(tr, prev, _oldState, newState) {
        const meta = tr.getMeta(triggerPluginKey) as
          | { close?: true }
          | undefined;
        if (meta?.close) return { startPos: null };

        if (prev.startPos !== null) {
          const mappedStart = tr.mapping.map(prev.startPos);
          if (validateOpen(mappedStart, newState)) {
            return { startPos: mappedStart };
          }
        }

        const start = findEnclosingMentionStart(newState);
        return { startPos: start };
      }
    },

    view(view) {
      viewRef = view;
      return {
        update(view) {
          const trigger = triggerPluginKey.getState(view.state);
          const wasOpen = bridge.state.open;
          if (!trigger || trigger.startPos === null) {
            if (wasOpen) resetBridgeState();
            return;
          }
          const cursor = view.state.selection.from;
          const query = view.state.doc.textBetween(
            trigger.startPos + 1,
            cursor,
            '\n'
          );
          const c = view.coordsAtPos(cursor);
          const caretRect = {
            top: c.top,
            bottom: c.bottom,
            left: c.left,
            right: c.left,
            width: 0,
            height: c.bottom - c.top
          };
          if (!wasOpen || bridge.state.query !== query) {
            bridge.state.highlight = 0;
          }
          bridge.state.open = true;
          bridge.state.query = query;
          bridge.state.caretRect = caretRect;
        },
        destroy() {
          if (viewRef === view) {
            viewRef = null;
            resetBridgeState();
          }
        }
      };
    },

    props: {
      handleKeyDown(view, event) {
        const trigger = triggerPluginKey.getState(view.state);
        if (!trigger || trigger.startPos === null) return false;
        switch (event.key) {
          case 'Escape':
            event.preventDefault();
            close();
            return true;
          case 'Enter':
            event.preventDefault();
            bridge.commitFromPopup();
            return true;
          case 'ArrowDown':
            event.preventDefault();
            bridge.state.highlight = bridge.state.highlight + 1;
            return true;
          case 'ArrowUp':
            event.preventDefault();
            bridge.state.highlight = Math.max(0, bridge.state.highlight - 1);
            return true;
          case 'Tab':
            event.preventDefault();
            bridge.commitFromPopup();
            return true;
          default:
            return false;
        }
      }
    }
  });
}

/* --- Decoration + delete/click handling ----------------------------------- */

const decorationPluginKey = new PluginKey<DecorationSet>(
  'mindstream-user-mention-decoration'
);

/** Force a decoration rebuild — used by the host when the signed-in user or the
 *  candidate list resolves after the doc first rendered, so existing mentions
 *  re-evaluate the "self" highlight. */
export function refreshMentionDecorations(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(decorationPluginKey, { refresh: true }));
}

interface MentionRange {
  from: number;
  to: number;
  href: string;
}

function mentionTextRanges(state: EditorState): MentionRange[] {
  const ranges: MentionRange[] = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const mark = node.marks.find((m) => parseUserHref(m.attrs.href));
    const href = mark?.attrs.href;
    if (typeof href !== 'string') return;
    const last = ranges[ranges.length - 1];
    if (last && last.href === href && last.to === pos) {
      last.to = pos + node.text.length;
    } else {
      ranges.push({ from: pos, to: pos + node.text.length, href });
    }
  });
  return ranges;
}

function marksWithoutLink(state: EditorState): Mark[] {
  const type = state.schema.marks.link;
  const active = state.storedMarks ?? state.selection.$from.marks();
  if (!type) return [...active];
  return active.filter((mark) => mark.type !== type);
}

// A plain Backspace at a mention's right edge, or a plain Delete at its left
// edge, removes the whole mention in one stroke — it reads as a single object,
// not text to nibble. Word-wise deletes (Ctrl/Alt/Meta) fall through.
function removeAdjacentMention(
  view: EditorView,
  event: KeyboardEvent
): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  const { state } = view;
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const pos = selection.from;

  let range: MentionRange | undefined;
  if (event.key === 'Backspace') {
    range = mentionTextRanges(state).find((r) => r.to === pos);
  } else if (event.key === 'Delete') {
    range = mentionTextRanges(state).find((r) => r.from === pos);
  }
  if (!range) return false;

  event.preventDefault();
  const tr = state.tr.delete(range.from, range.to);
  tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(range.from, -1)));
  tr.setStoredMarks(marksWithoutLink(state));
  view.dispatch(tr);
  return true;
}

function closestMentionElement(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  const decorated = target.closest('.user-mention');
  if (decorated) return decorated;
  const anchor = target.closest('a');
  // Post-neutralisation the original scheme lives on `data-note-href`; before
  // that (and in unit tests) it's still on `href`. Accept either.
  const href =
    anchor?.getAttribute('data-note-href') ?? anchor?.getAttribute('href');
  return anchor && parseUserHref(href) ? anchor : null;
}

function isMentionTooltipElement(element: Element): boolean {
  const previewLink = element.querySelector('.link-display[href]');
  if (parseUserHref(previewLink?.getAttribute('href'))) return true;
  const input = element.querySelector('input');
  return input instanceof HTMLInputElement && !!parseUserHref(input.value);
}

function hideNativeMentionTooltips(): void {
  if (typeof document === 'undefined') return;
  document
    .querySelectorAll('.milkdown-link-preview, .milkdown-link-edit')
    .forEach((element) => {
      if (isMentionTooltipElement(element)) {
        element.setAttribute('data-show', 'false');
      }
    });
}

function hideNativeMentionTooltipsSoon(): void {
  hideNativeMentionTooltips();
  window.setTimeout(hideNativeMentionTooltips, 75);
}

// Exported for tests: exercised against a real EditorView.
export function userMentionDecorationPlugin(
  options: UserMentionPluginOptions
): Plugin {
  function build(
    doc: Parameters<typeof DecorationSet.create>[0]
  ): DecorationSet {
    const decos: Decoration[] = [];
    const me = options.currentUsername();
    doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return;
      const mark = node.marks.find((m) => parseUserHref(m.attrs.href));
      const username = parseUserHref(mark?.attrs.href);
      if (!username) return;
      const isSelf = me !== null && me === username;
      decos.push(
        Decoration.inline(pos, pos + node.text.length, {
          class: isSelf ? 'user-mention user-mention-self' : 'user-mention',
          'data-mention-username': username
        })
      );
    });
    return DecorationSet.create(doc, decos);
  }

  return new Plugin<DecorationSet>({
    key: decorationPluginKey,
    view(view) {
      const suppressHoverTooltip = (event: MouseEvent) => {
        if (!closestMentionElement(event.target)) return;
        hideNativeMentionTooltipsSoon();
        event.stopImmediatePropagation();
      };
      const hideTooltip = (event: MouseEvent) => {
        if (!closestMentionElement(event.target)) return;
        hideNativeMentionTooltipsSoon();
      };
      // Mentions render as real `<a>` anchors. Even with the href neutralised
      // (see note-link-schema.ts), cancel any default navigation in the
      // capture phase — parity with note links, and cheap insurance against
      // the Android WebView following a custom scheme.
      const preventMentionNavigation = (event: MouseEvent) => {
        if (closestMentionElement(event.target)) event.preventDefault();
      };

      view.dom.addEventListener('mousemove', suppressHoverTooltip, true);
      view.dom.addEventListener('mouseover', suppressHoverTooltip, true);
      view.dom.addEventListener('mousedown', hideTooltip, true);
      view.dom.addEventListener('click', hideTooltip, true);
      view.dom.addEventListener('click', preventMentionNavigation, true);

      return {
        destroy() {
          view.dom.removeEventListener('mousemove', suppressHoverTooltip, true);
          view.dom.removeEventListener('mouseover', suppressHoverTooltip, true);
          view.dom.removeEventListener('mousedown', hideTooltip, true);
          view.dom.removeEventListener('click', hideTooltip, true);
          view.dom.removeEventListener('click', preventMentionNavigation, true);
        }
      };
    },
    state: {
      init(_, state) {
        return build(state.doc);
      },
      apply(tr, prev) {
        const meta = tr.getMeta(decorationPluginKey) as
          | { refresh?: true }
          | undefined;
        if (!tr.docChanged && !meta?.refresh) return prev;
        return build(tr.doc);
      }
    },
    props: {
      decorations(state) {
        return decorationPluginKey.getState(state);
      },
      handleKeyDown(view, event) {
        if (event.key === 'Backspace' || event.key === 'Delete') {
          return removeAdjacentMention(view, event);
        }
        return false;
      }
    }
  });
}

/* --- Public factory ------------------------------------------------------- */

/**
 * Two `$prose` plugins wrapped as one Milkdown plugin array (Crepe's `.use`
 * accepts arrays). The trigger owns menu open/close + key handling; the
 * decoration runs independently to style existing mentions.
 */
export function userMentionPlugins(
  bridge: UserMentionBridge,
  options: UserMentionPluginOptions
) {
  return [
    $prose(() => userMentionTriggerPlugin(bridge)),
    $prose(() => userMentionDecorationPlugin(options))
  ];
}
