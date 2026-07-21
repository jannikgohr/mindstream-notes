/**
 * The `[[` trigger plugin.
 *
 * Detects `[[` typed at the cursor, opens the menu through the per-editor
 * `WikilinkBridge`, tracks the query span between `[[` and the cursor, and
 * intercepts Arrow / Enter / Esc while the menu is open. Auto-paired
 * brackets and a bare `[[` both reach the same code path because the
 * plugin only looks at what is in the doc, never at what was typed.
 */

import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState
} from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { noteHref } from '../../wikilink-href';
import type { WikilinkBridge } from '../../wikilink-bridge.svelte';
import { resolveNoteIdByTitle } from './note-resolve';

/* --- Trigger plugin -------------------------------------------------------- */

interface TriggerState {
  /** Doc position of the `[` of `[[`. Null when menu is closed. */
  startPos: number | null;
}

const triggerPluginKey = new PluginKey<TriggerState>(
  'mindstream-wikilink-trigger'
);

/**
 * Maximum query length — closes the menu if the user types something
 * absurd. Stops a runaway "I forgot to close my brackets" from holding
 * the menu open across the whole note.
 */
const MAX_QUERY_LEN = 80;

/**
 * How far back from the cursor we'll scan looking for the opening
 * `[[`. Wikilink titles aren't long, and this also caps the per-
 * transaction cost of the auto-open scan that runs in `apply()`.
 */
const AUTO_OPEN_LOOKBACK = 200;

/** Parent node types where we never want the wikilink menu to open —
 *  brackets inside these are literal, not link syntax. */
const NON_WIKILINK_PARENTS = new Set(['code_block', 'fence', 'html_block']);

/**
 * If the cursor is positioned inside or right after an unclosed `[[`
 * in the current text block, return the doc position of the `[[`'s
 * first `[`; otherwise `null`. This is what powers the auto-open
 * behaviour — clicking into an existing `[[Title]]` opens the menu
 * just like typing `[[` does, so the user can change which note the
 * link points to without retyping the brackets.
 *
 * The scan is intentionally one-directional: we walk backwards from
 * the cursor looking for `[[`, aborting on `\n`, `]`, or a window
 * limit. We don't require a closing `]]` ahead — typing `[[` with no
 * close yet should still open the menu (that's the original typing
 * trigger). The existing `validateOpen` bounds check will close the
 * menu once the user moves past `]]`.
 */
function findEnclosingWikilinkStart(state: EditorState): number | null {
  const sel = state.selection;
  if (!sel.empty) return null;
  const $from = sel.$from;
  if (!$from.parent.isTextblock) return null;
  if (NON_WIKILINK_PARENTS.has($from.parent.type.name)) return null;
  const codeMark = state.schema.marks.code;
  if (codeMark && codeMark.isInSet($from.marks())) return null;

  const offset = $from.parentOffset;
  if (offset < 2) return null;

  const parentText = $from.parent.textBetween(
    0,
    $from.parent.content.size,
    '\n',
    '\n'
  );
  const searchStart = Math.max(1, offset - AUTO_OPEN_LOOKBACK);
  for (let i = offset - 1; i >= searchStart; i--) {
    const c = parentText[i];
    // `\n` shouldn't appear inside a text block; defensive against
    // any leaf-text inclusion in `textBetween`. `]` aborts because a
    // valid wikilink's interior forbids brackets — finding one going
    // backward means we've stepped past a closed link.
    if (c === '\n' || c === ']') return null;
    if (c === '[' && parentText[i - 1] === '[') {
      // openIdx is the parent-offset of the FIRST `[`. Convert to a
      // doc position by adding the parent's start position.
      return $from.start() + (i - 1);
    }
  }
  return null;
}

/**
 * Same bounds check `apply` already used to decide whether to keep an
 * existing open menu open through a transaction, lifted into a helper
 * so the cursor-based auto-open can reuse it.
 */
function validateOpen(startPos: number, state: EditorState): boolean {
  const cursor = state.selection.from;
  if (cursor < startPos + 2) return false;
  if (state.doc.resolve(startPos).parent !== state.doc.resolve(cursor).parent) {
    return false;
  }
  const queryRaw = state.doc.textBetween(startPos + 2, cursor, '\n');
  if (
    queryRaw.includes('\n') ||
    queryRaw.includes(']]') ||
    queryRaw.includes('[[')
  ) {
    return false;
  }
  return queryRaw.length <= MAX_QUERY_LEN;
}

/**
 * Commit target for autocomplete insertion. When the cursor is inside an
 * already-complete `[[Title]]`, replace the whole wikilink instead of only
 * the text from `[[` to the cursor; otherwise committing in the middle leaves
 * the existing suffix behind (`[[Test Note]] Note]]`).
 */
function findInsertionReplaceTo(
  state: EditorState,
  startPos: number,
  cursor: number
): number {
  const $start = state.doc.resolve(startPos);
  const $cursor = state.doc.resolve(cursor);
  if ($start.parent !== $cursor.parent) return cursor;

  const parentStart = $cursor.start();
  const startOffset = startPos - parentStart;
  const cursorOffset = cursor - parentStart;
  const parentText = $cursor.parent.textBetween(
    0,
    $cursor.parent.content.size,
    '\n',
    '\n'
  );

  if (parentText.slice(startOffset, startOffset + 2) !== '[[') return cursor;

  for (let i = cursorOffset; i < parentText.length; i++) {
    const c = parentText[i];
    if (c === '\n' || c === '[') return cursor;
    if (c === ']') {
      return parentText[i + 1] === ']' ? parentStart + i + 2 : cursor;
    }
  }

  return cursor;
}

export function wikilinkTriggerPlugin(
  bridge: WikilinkBridge
): Plugin<TriggerState> {
  let viewRef: EditorView | null = null;
  let suppressAutoOpen = false;
  let suppressAutoOpenTimer: ReturnType<typeof setTimeout> | null = null;

  function resetBridgeState() {
    bridge.state.open = false;
    bridge.state.query = '';
    bridge.state.caretRect = null;
    bridge.state.highlight = 0;
  }

  function suppressModifierClickAutoOpen() {
    suppressAutoOpen = true;
    if (suppressAutoOpenTimer) clearTimeout(suppressAutoOpenTimer);
    suppressAutoOpenTimer = setTimeout(() => {
      suppressAutoOpen = false;
      suppressAutoOpenTimer = null;
    }, 500);
  }

  function isModifiedWikilinkMouseEvent(event: MouseEvent): boolean {
    if (!event.ctrlKey && !event.metaKey) return false;
    const target = event.target;
    return target instanceof Element && !!target.closest('.wikilink');
  }

  function close() {
    resetBridgeState();
    if (viewRef) {
      viewRef.dispatch(
        viewRef.state.tr.setMeta(triggerPluginKey, { close: true })
      );
    }
  }

  function insert(note: { id: string; title: string }) {
    if (!viewRef) return;
    const view = viewRef;
    const trigger = triggerPluginKey.getState(view.state);
    const start = trigger?.startPos ?? null;
    if (start === null) {
      close();
      return;
    }
    const cursor = view.state.selection.from;
    const replaceTo = findInsertionReplaceTo(view.state, start, cursor);
    const label = note.title.trim() || 'Untitled';
    const linkType = view.state.schema.marks.link;
    if (!linkType) {
      const tr = view.state.tr.insertText(label, start, replaceTo);
      tr.setMeta(triggerPluginKey, { close: true });
      view.dispatch(tr);
      view.focus();
      close();
      return;
    }
    const linkMark = linkType.create({
      href: noteHref(note.id),
      title: null
    });
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
        // Explicit close meta wins outright (Esc, the insert path).
        const meta = tr.getMeta(triggerPluginKey) as
          | { close?: true }
          | undefined;
        if (meta?.close) return { startPos: null };

        // 1. If a menu was already open, try to keep it open by
        //    re-validating against the new state. The mapping step
        //    moves the start position through doc edits so a typo
        //    earlier in the doc doesn't desync the anchor.
        if (prev.startPos !== null) {
          const mappedStart = tr.mapping.map(prev.startPos);
          if (validateOpen(mappedStart, newState)) {
            return { startPos: mappedStart };
          }
          // Fall through: the old open is no longer valid (cursor
          // moved out, `]]` typed, etc.) — but maybe the cursor has
          // landed inside a DIFFERENT wikilink, in which case we
          // should reopen at the new location rather than blink
          // closed for a tick.
        }

        // 2. Auto-open: if the cursor is inside (or right after) a
        //    `[[…` in the current text block, open the menu anchored
        //    to that `[[`. This covers both the original "user typed
        //    `[[`" case (no `]]` ahead yet) AND clicking / arrow-
        //    keying into an existing `[[Title]]`, which is what lets
        //    the user change the link target without retyping the
        //    brackets.
        if (suppressAutoOpen) return { startPos: null };
        const start = findEnclosingWikilinkStart(newState);
        return { startPos: start };
      }
    },

    view(view) {
      viewRef = view;
      return {
        update(view, prevState) {
          const trigger = triggerPluginKey.getState(view.state);
          const wasOpen = bridge.state.open;
          if (!trigger || trigger.startPos === null) {
            if (wasOpen) {
              bridge.state.open = false;
              bridge.state.query = '';
              bridge.state.caretRect = null;
              bridge.state.highlight = 0;
            }
            return;
          }
          const cursor = view.state.selection.from;
          const query = view.state.doc.textBetween(
            trigger.startPos + 2,
            cursor,
            '\n'
          );
          // Caret rect in viewport coords. The popup hands this to
          // floating-ui's virtual element so positioning survives
          // ancestors with CSS transforms (dockview panels) and the
          // sidebar opening/closing without us re-deriving coords.
          const c = view.coordsAtPos(cursor);
          const caretRect = {
            top: c.top,
            bottom: c.bottom,
            left: c.left,
            right: c.left,
            width: 0,
            height: c.bottom - c.top
          };
          // Only reset highlight when the query string actually changes
          // (so arrow-key nav isn't clobbered by a tick of reactivity).
          if (!wasOpen || bridge.state.query !== query) {
            bridge.state.highlight = 0;
          }
          bridge.state.open = true;
          bridge.state.query = query;
          bridge.state.caretRect = caretRect;
          // (intentionally don't touch newState/prevState beyond what
          // ProseMirror already gives us)
          void prevState;
        },
        destroy() {
          if (viewRef === view) {
            viewRef = null;
            resetBridgeState();
            if (suppressAutoOpenTimer) {
              clearTimeout(suppressAutoOpenTimer);
              suppressAutoOpenTimer = null;
            }
            suppressAutoOpen = false;
          }
        }
      };
    },

    props: {
      handleDOMEvents: {
        mousedown(view, event) {
          if (!isModifiedWikilinkMouseEvent(event)) return false;
          suppressModifierClickAutoOpen();
          resetBridgeState();
          view.dispatch(
            view.state.tr.setMeta(triggerPluginKey, { close: true })
          );
          return false;
        }
      },
      // No `handleTextInput` — auto-open lives in apply() now, so the
      // menu reacts to the doc + cursor state regardless of how the
      // brackets got there (typed, pasted, clicked-into, etc.). This
      // also drops a previous microtask-dispatch dance that was only
      // needed because handleTextInput ran before auto-pair's
      // transaction had landed.

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
            // Tab also commits — matches the convention from most
            // typeahead UIs and avoids the user accidentally
            // indenting the line via prosemirror's tab handling.
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
