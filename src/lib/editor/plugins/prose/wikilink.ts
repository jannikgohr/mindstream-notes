/**
 * Wikilinks — Obsidian-style `[[Note Title]]` editing affordances backed by
 * standard markdown links: `[Note Title](mindstream://note/<id>)`.
 *
 * Three concerns in one file because they share state and the surface
 * area is small:
 *
 *   1. **Trigger plugin** — detects `[[` typed at the cursor, opens a
 *      menu via the per-editor `WikilinkBridge`, tracks the query
 *      span (text between `[[` and the cursor), and intercepts
 *      Arrow / Enter / Esc while open. Auto-pair brackets and the
 *      plain `[[` case both reach the same trigger because we only
 *      look at what's in the doc, not what the user typed.
 *
 *   2. **Decoration plugin** — decorates ID-backed note links so they read
 *      like `[[Title]]` in the editor. Legacy literal `[[Title]]` spans are
 *      still styled and clickable as a compatibility fallback.
 *
 *   3. **Click handler** — plain click (when enabled in settings) or
 *      Cmd/Ctrl+click on a `.wikilink` opens by stable note ID when present,
 *      falling back to title resolution only for legacy literal wikilinks.
 *      When plain click is disabled, click is left to ProseMirror.
 *
 * The trigger plugin and the popup component share a `WikilinkBridge`
 * object that NoteEditor creates per editor instance. The bridge is how
 * the plugin says "menu just opened with this query" and the popup says
 * "user picked this title" without either side reaching into the other's
 * implementation. Per-editor (not module-level) so two open notes don't
 * fight over a single popup.
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
import { requestOpenNote } from '$lib/stores/open-note-intent.svelte';
import { tree } from '$lib/stores/tree.svelte';
import { noteHref, parseNoteHref } from '../wikilink-href';
import type { WikilinkBridge } from '../wikilink-bridge.svelte';

// Re-export so consumers can still get everything wikilink-related
// through this one module — the bridge factory lives in its own
// .svelte.ts because Svelte's compiler treats the `$` prefix as
// reserved in .svelte.ts files, which would block this file's
// `import { $prose } from '@milkdown/kit/utils'`.
export type { WikilinkBridge } from '../wikilink-bridge.svelte';
export { createWikilinkBridge } from '../wikilink-bridge.svelte';

/* --- Note link resolution -------------------------------------------------- */

// The href format itself is shared with the source-mode plugin (and the
// render-time neutralizer), so it lives at the plugins root. Re-exported
// here so wikilink consumers can still reach everything through this module.
export { noteHref, parseNoteHref } from '../wikilink-href';

function resolveNoteTitleById(id: string, fallback: string): string {
  const title = tree.notesById[id]?.title.trim();
  return title || fallback;
}

/**
 * Find a note by exact title (case-insensitive). Excludes trashed notes
 * so a "ghost" title from the trash doesn't take precedence over a
 * real note with the same name.
 *
 * Same-title collisions: returns the most-recently-modified match.
 * That's arbitrary but stable per snapshot of the tree, and in practice
 * users notice the conflict quickly because the popup itself shows
 * both entries.
 */
export function resolveNoteIdByTitle(title: string): string | null {
  const wanted = title.trim().toLowerCase();
  if (!wanted) return null;
  let best: { id: string; modified: string } | null = null;
  for (const note of Object.values(tree.notesById)) {
    if (note.trashed) continue;
    if (note.title.trim().toLowerCase() !== wanted) continue;
    if (!best || note.modified > best.modified) {
      best = { id: note.id, modified: note.modified };
    }
  }
  return best?.id ?? null;
}

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

function wikilinkTriggerPlugin(bridge: WikilinkBridge): Plugin<TriggerState> {
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

/* --- Decoration + click handler ------------------------------------------- */

const decorationPluginKey = new PluginKey('mindstream-wikilink-decoration');

function closestNoteLinkElement(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  const decorated = target.closest('.wikilink-note-link');
  if (decorated) return decorated;

  const anchor = target.closest('a[href]');
  const href = anchor?.getAttribute('href');
  return parseNoteHref(href) ? anchor : null;
}

function isNoteLinkTooltipElement(element: Element): boolean {
  const previewLink = element.querySelector('.link-display[href]');
  if (parseNoteHref(previewLink?.getAttribute('href'))) return true;

  const input = element.querySelector('input');
  return input instanceof HTMLInputElement && !!parseNoteHref(input.value);
}

function hideNativeNoteLinkTooltips(): void {
  if (typeof document === 'undefined') return;

  document
    .querySelectorAll('.milkdown-link-preview, .milkdown-link-edit')
    .forEach((element) => {
      if (!isNoteLinkTooltipElement(element)) return;
      element.setAttribute('data-show', 'false');
    });
}

function hideNativeNoteLinkTooltipsSoon(): void {
  hideNativeNoteLinkTooltips();
  window.setTimeout(hideNativeNoteLinkTooltips, 75);
}

/**
 * Pattern: `[[…]]` where the inside has no brackets and no newlines.
 * Non-greedy on the inside so `[[a]] [[b]]` matches twice rather than
 * once across both.
 *
 * Escape rules:
 *   - Outside a character class, `[` opens a class → must escape (`\[`).
 *     `]` is just a literal there → no escape needed.
 *   - Inside a character class, `[` is literal → no escape needed.
 *     `]` closes the class → must escape (`\]`).
 */
const WIKILINK_RE = /\[\[([^[\]\n]+?)]]/g;

export interface WikilinkPluginOptions {
  openOnClick: () => boolean;
}

interface NoteLinkTextRange {
  from: number;
  to: number;
  href: string;
  mark: Mark;
}

interface LinkBoundaryEdit {
  pos: number;
  mark: Mark;
}

interface LinkBoundaryMode {
  mode: 'inside' | 'outside';
  side: 'start' | 'end';
}

function noteLinkTextRanges(state: EditorState): NoteLinkTextRange[] {
  const ranges: NoteLinkTextRange[] = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const mark = node.marks.find((mark) => parseNoteHref(mark.attrs.href));
    if (!mark) return;
    const href = mark?.attrs.href;
    if (typeof href !== 'string') return;

    const last = ranges[ranges.length - 1];
    if (last && last.href === href && last.to === pos && last.mark.eq(mark)) {
      last.to = pos + node.text.length;
    } else {
      ranges.push({ from: pos, to: pos + node.text.length, href, mark });
    }
  });
  return ranges;
}

function noteLinkDeletionRange(
  state: EditorState,
  event: KeyboardEvent
): { from: number; to: number } | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return null;
  if (!selection.empty) return { from: selection.from, to: selection.to };
  const pos = selection.from;

  if (event.key === 'Backspace') {
    if (pos === 0) return null;
    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      return { from: pos - 1, to: pos };
    }
    const $from = selection.$from;
    if (!$from.parent.isTextblock) return null;
    const offset = $from.parentOffset;
    if (offset === 0) return null;
    const text = $from.parent.textBetween(
      0,
      $from.parent.content.size,
      '\n',
      '\n'
    );
    let start = offset;
    while (start > 0 && /\s/.test(text[start - 1])) start -= 1;
    while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
    return { from: $from.start() + start, to: pos };
  }

  if (event.key === 'Delete') {
    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      return pos < state.doc.content.size ? { from: pos, to: pos + 1 } : null;
    }
    const $from = selection.$from;
    if (!$from.parent.isTextblock) return null;
    const offset = $from.parentOffset;
    const text = $from.parent.textBetween(
      0,
      $from.parent.content.size,
      '\n',
      '\n'
    );
    if (offset >= text.length) return null;
    let end = offset;
    while (end < text.length && /\s/.test(text[end])) end += 1;
    while (end < text.length && !/\s/.test(text[end])) end += 1;
    return { from: pos, to: $from.start() + end };
  }

  return null;
}

function wholeNoteLinkDeletion(
  state: EditorState,
  event: KeyboardEvent
): { from: number; to: number; mark: Mark } | null {
  const deletion = noteLinkDeletionRange(state, event);
  if (!deletion || deletion.from >= deletion.to) return null;

  const range = noteLinkTextRanges(state).find(
    (range) =>
      deletion.from <= range.from &&
      deletion.to >= range.to &&
      deletion.from < range.to &&
      deletion.to > range.from
  );
  if (!range) return null;

  return { from: deletion.from, to: deletion.to, mark: range.mark };
}

function linkMarkType(state: EditorState) {
  return state.schema.marks.link ?? null;
}

function linkMarkIn(marks: readonly Mark[], state: EditorState): Mark | null {
  const type = linkMarkType(state);
  if (!type) return null;
  return marks.find((mark) => mark.type === type) ?? null;
}

function activeMarks(state: EditorState): readonly Mark[] {
  return state.storedMarks ?? state.selection.$from.marks();
}

function marksWithoutLink(state: EditorState): Mark[] {
  const type = linkMarkType(state);
  if (!type) return [...activeMarks(state)];
  return activeMarks(state).filter((mark) => mark.type !== type);
}

function marksWithLink(state: EditorState, mark: Mark): Mark[] {
  return [...mark.addToSet(marksWithoutLink(state))];
}

function exactStoredLinkMark(state: EditorState, mark: Mark): Mark | null {
  return state.storedMarks?.find((stored) => stored.eq(mark)) ?? null;
}

function textNodeLinkMarkAtBoundary(
  state: EditorState,
  pos: number,
  side: 'before' | 'after'
): Mark | null {
  const $pos = state.doc.resolve(pos);
  const node = side === 'before' ? $pos.nodeBefore : $pos.nodeAfter;
  if (!node?.isText) return null;
  return linkMarkIn(node.marks, state);
}

function trailingBoundaryLinkMark(
  state: EditorState,
  pos: number
): Mark | null {
  const before = textNodeLinkMarkAtBoundary(state, pos, 'before');
  if (!before) return null;
  const after = textNodeLinkMarkAtBoundary(state, pos, 'after');
  return after?.eq(before) ? null : before;
}

function leadingBoundaryLinkMark(state: EditorState, pos: number): Mark | null {
  const after = textNodeLinkMarkAtBoundary(state, pos, 'after');
  if (!after) return null;
  const before = textNodeLinkMarkAtBoundary(state, pos, 'before');
  return before?.eq(after) ? null : after;
}

function boundaryEditMatches(
  edit: LinkBoundaryEdit | null,
  pos: number,
  mark: Mark | null
): boolean {
  return !!edit && !!mark && edit.pos === pos && edit.mark.eq(mark);
}

function boundaryEditAt(edit: LinkBoundaryEdit | null, pos: number): boolean {
  return !!edit && edit.pos === pos;
}

function deleteNoteLinkText(
  view: EditorView,
  event: KeyboardEvent
): LinkBoundaryEdit | null {
  const deletion = wholeNoteLinkDeletion(view.state, event);
  if (!deletion) return null;

  const tr = view.state.tr.delete(deletion.from, deletion.to);
  const mappedPos = tr.mapping.map(deletion.from, -1);
  tr.setSelection(TextSelection.create(tr.doc, mappedPos));
  tr.setStoredMarks(marksWithLink(view.state, deletion.mark));
  view.dispatch(tr);
  return { pos: mappedPos, mark: deletion.mark };
}

// Delete one character while staying in boundary editing: Backspace eats the
// link character to the left (right-side editing), Delete the one to the right
// (left-side editing). Keeps the link mark stored and tracks the new caret so
// the caret doesn't pop "outside" the moment the link loses its last edge
// character. Returns null when the deletion would leave the link text (let the
// default handler — or the whole-link path — take over instead).
function deleteInsideLinkBoundary(
  view: EditorView,
  event: KeyboardEvent,
  edit: LinkBoundaryEdit
): LinkBoundaryEdit | null {
  const { state } = view;
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const pos = selection.from;
  if (pos !== edit.pos) return null;

  if (event.key === 'Backspace') {
    if (pos === 0) return null;
    const before = textNodeLinkMarkAtBoundary(state, pos, 'before');
    if (!before?.eq(edit.mark)) return null;
    const nextPos = pos - 1;
    const tr = state.tr.delete(nextPos, pos);
    tr.setSelection(TextSelection.create(tr.doc, nextPos));
    tr.setStoredMarks(marksWithLink(state, edit.mark));
    view.dispatch(tr);
    return { pos: nextPos, mark: edit.mark };
  }

  if (event.key === 'Delete') {
    const after = textNodeLinkMarkAtBoundary(state, pos, 'after');
    if (!after?.eq(edit.mark)) return null;
    const tr = state.tr.delete(pos, pos + 1);
    tr.setSelection(TextSelection.create(tr.doc, pos));
    tr.setStoredMarks(marksWithLink(state, edit.mark));
    view.dispatch(tr);
    return { pos, mark: edit.mark };
  }

  return null;
}

// Outside the link, treat it as one atomic object: a plain Backspace sitting at
// its right edge, or a plain Delete sitting at its left edge, removes the whole
// link in one stroke instead of nibbling the outermost character — which reads
// as confusing when the caret isn't even in link-editing mode. Word-wise
// deletes (Ctrl/Alt/Meta) fall through to the existing handling.
function removeAdjacentNoteLink(
  view: EditorView,
  event: KeyboardEvent,
  boundary: LinkBoundaryMode | null
): boolean {
  if (!boundary || boundary.mode !== 'outside') return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  const { state } = view;
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const pos = selection.from;

  let range: NoteLinkTextRange | undefined;
  if (event.key === 'Backspace' && boundary.side === 'end') {
    range = noteLinkTextRanges(state).find((r) => r.to === pos);
  } else if (event.key === 'Delete' && boundary.side === 'start') {
    range = noteLinkTextRanges(state).find((r) => r.from === pos);
  }
  if (!range) return false;

  event.preventDefault();
  const tr = state.tr.delete(range.from, range.to);
  tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(range.from, -1)));
  tr.setStoredMarks(marksWithoutLink(state));
  view.dispatch(tr);
  return true;
}

function insertLinkBoundaryText(
  view: EditorView,
  pos: number,
  text: string,
  mark: Mark
): number | null {
  if (!text) return null;
  const marks = marksWithLink(view.state, mark);
  const textNode = view.state.schema.text(text, marks);
  const tr = view.state.tr.replaceWith(pos, pos, textNode);
  tr.setSelection(TextSelection.create(tr.doc, pos + text.length));
  tr.setStoredMarks(marks);
  view.dispatch(tr);
  return pos + text.length;
}

function shouldTypeOutsideLinkBoundary(
  state: EditorState,
  pos: number
): boolean {
  const boundaryMark =
    trailingBoundaryLinkMark(state, pos) ?? leadingBoundaryLinkMark(state, pos);
  if (!boundaryMark) return false;
  return !exactStoredLinkMark(state, boundaryMark);
}

function typeOutsideLinkBoundary(
  view: EditorView,
  from: number,
  to: number,
  text: string
): boolean {
  if (from !== to || !shouldTypeOutsideLinkBoundary(view.state, from)) {
    return false;
  }

  const type = linkMarkType(view.state);
  const tr = view.state.tr.insertText(text, from, to);
  if (type) tr.removeMark(from, from + text.length, type);
  tr.setStoredMarks(marksWithoutLink(view.state));
  view.dispatch(tr);
  return true;
}

function toggleLinkBoundaryEditing(
  view: EditorView,
  event: KeyboardEvent,
  activeBoundaryEdit: LinkBoundaryEdit | null
): LinkBoundaryEdit | 'exit' | null {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return null;
  const { state } = view;
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;

  const pos = selection.from;
  const trailing = trailingBoundaryLinkMark(state, pos);
  const leading = leadingBoundaryLinkMark(state, pos);
  const activeTrailing = boundaryEditMatches(activeBoundaryEdit, pos, trailing);
  const activeLeading = boundaryEditMatches(activeBoundaryEdit, pos, leading);
  const activeAtBoundary = boundaryEditAt(activeBoundaryEdit, pos);
  const exitMark =
    (event.key === 'ArrowRight' &&
      trailing &&
      (activeAtBoundary ||
        activeTrailing ||
        exactStoredLinkMark(state, trailing))) ||
    (event.key === 'ArrowLeft' &&
      leading &&
      (activeAtBoundary ||
        activeLeading ||
        exactStoredLinkMark(state, leading)));
  if (exitMark) {
    event.preventDefault();
    view.dispatch(state.tr.setStoredMarks(marksWithoutLink(state)));
    return 'exit';
  }

  const enterMark =
    (event.key === 'ArrowLeft' &&
    trailing &&
    !activeTrailing &&
    !exactStoredLinkMark(state, trailing)
      ? trailing
      : null) ??
    (event.key === 'ArrowRight' &&
    leading &&
    !activeLeading &&
    !exactStoredLinkMark(state, leading)
      ? leading
      : null);
  if (!enterMark) return null;

  event.preventDefault();
  view.dispatch(state.tr.setStoredMarks(marksWithLink(state, enterMark)));
  return { pos, mark: enterMark };
}

// Arrow movement that stays within the link text: when the caret steps
// onto the display name's first or last position *from inside*, keep
// link editing active by pinning the boundary it lands on. Without
// this, the default caret move clears the stored marks, the boundary
// reads as "outside", and the next character falls out of the link —
// which felt like being kicked out of editing mid-word.
function arrowWithinLinkText(
  view: EditorView,
  event: KeyboardEvent,
  activeEdit: LinkBoundaryEdit | null
): LinkBoundaryEdit | null {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return null;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    return null;
  }
  const { state } = view;
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const pos = selection.from;
  const forward = event.key === 'ArrowRight';

  // The character the caret is about to step over must be link text…
  const stepOver = textNodeLinkMarkAtBoundary(
    state,
    pos,
    forward ? 'after' : 'before'
  );
  if (!stepOver) return null;
  // …and the caret must already be inside the link: either the other
  // neighbour carries the same mark, or this position is an active
  // boundary edit / stored-mark entry (covers one-character links).
  const behind = textNodeLinkMarkAtBoundary(
    state,
    pos,
    forward ? 'before' : 'after'
  );
  const inside =
    behind?.eq(stepOver) ||
    boundaryEditAt(activeEdit, pos) ||
    !!exactStoredLinkMark(state, stepOver);
  if (!inside) return null;

  // Only the landing position at the display name's edge needs a pin —
  // strictly-inside positions keep the mark through ProseMirror's
  // default marks() resolution.
  const target = forward ? pos + 1 : pos - 1;
  const boundaryMark = forward
    ? trailingBoundaryLinkMark(state, target)
    : leadingBoundaryLinkMark(state, target);
  if (!boundaryMark?.eq(stepOver)) return null;

  const tr = state.tr.setSelection(TextSelection.create(state.doc, target));
  tr.setStoredMarks(marksWithLink(state, boundaryMark));
  view.dispatch(tr);
  return { pos: target, mark: boundaryMark };
}

// Exported for tests: the boundary-editing state machine needs a real
// EditorView to exercise, and the $prose wrapper requires a Milkdown ctx.
export function wikilinkDecorationPlugin(
  bridge: WikilinkBridge,
  options: WikilinkPluginOptions
): Plugin {
  let pendingEmptyNoteLink: LinkBoundaryEdit | null = null;
  let activeBoundaryLinkEdit: LinkBoundaryEdit | null = null;
  let measuredBracketFontSize: string | null = null;

  // The `[[`/`]]` brackets are CSS pseudo-elements, so the virtual cursor at a
  // boundary renders just inside them. When the caret is "outside" the link we
  // nudge it clear of the brackets so typing flows from the cursor instead of
  // dropping a character behind it. Measure the real bracket width (the font is
  // a variable, so a fixed em can't line up) and publish it as a CSS variable.
  function updateBracketOffset(view: EditorView): void {
    const fontSize = window.getComputedStyle(view.dom).fontSize;
    if (fontSize === measuredBracketFontSize) return;

    const probe = document.createElement('span');
    probe.textContent = ']]';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'pre';
    probe.style.pointerEvents = 'none';
    view.dom.appendChild(probe);
    const bracketWidth = probe.getBoundingClientRect().width;
    probe.remove();

    // `.wikilink-note-link` pads each side by 0.15em; clear that too.
    const offset = bracketWidth + parseFloat(fontSize) * 0.15;
    if (!Number.isFinite(offset) || offset <= 0) return;
    view.dom.style.setProperty('--wikilink-bracket-offset', `${offset}px`);
    measuredBracketFontSize = fontSize;
  }

  function boundaryMode(view: EditorView): LinkBoundaryMode | null {
    const { state } = view;
    const { selection } = state;
    if (!(selection instanceof TextSelection) || !selection.empty) return null;
    const pos = selection.from;

    if (pendingEmptyNoteLink?.pos === pos) {
      return { mode: 'inside', side: 'end' };
    }

    const trailing = trailingBoundaryLinkMark(state, pos);
    const leading = leadingBoundaryLinkMark(state, pos);
    const boundaryMark = trailing ?? leading;
    if (!boundaryMark) return null;

    const side = trailing ? 'end' : 'start';

    if (boundaryEditAt(activeBoundaryLinkEdit, pos)) {
      return { mode: 'inside', side };
    }
    if (boundaryEditMatches(activeBoundaryLinkEdit, pos, boundaryMark))
      return { mode: 'inside', side };
    return {
      mode: exactStoredLinkMark(state, boundaryMark) ? 'inside' : 'outside',
      side
    };
  }

  function syncBoundaryMode(view: EditorView): void {
    const boundary = boundaryMode(view);
    if (boundary?.mode === 'outside') updateBracketOffset(view);
    view.dom.classList.toggle(
      'wikilink-boundary-inside',
      boundary?.mode === 'inside'
    );
    view.dom.classList.toggle(
      'wikilink-boundary-outside',
      boundary?.mode === 'outside'
    );
    view.dom.classList.toggle(
      'wikilink-boundary-start',
      boundary?.side === 'start'
    );
    view.dom.classList.toggle(
      'wikilink-boundary-end',
      boundary?.side === 'end'
    );
    if (boundary) {
      view.dom.dataset.wikilinkBoundary = boundary.mode;
      view.dom.dataset.wikilinkBoundarySide = boundary.side;
    } else {
      delete view.dom.dataset.wikilinkBoundary;
      delete view.dom.dataset.wikilinkBoundarySide;
    }
  }

  function setActiveBoundaryLinkEdit(
    view: EditorView,
    edit: LinkBoundaryEdit | null
  ): void {
    activeBoundaryLinkEdit = edit;
    syncBoundaryMode(view);
  }

  function clearLinkEditState(view: EditorView): void {
    pendingEmptyNoteLink = null;
    setActiveBoundaryLinkEdit(view, null);
  }

  // Both link-edit pins (`pendingEmptyNoteLink`, `activeBoundaryLinkEdit`) name
  // a single doc position that's only meaningful while the caret rests on it.
  // Structural edits we don't drive — a Backspace that merges lines, an Enter
  // that splits one — move the caret through ProseMirror's default handlers,
  // leaving a pin stranded at a stale position. A stranded pin later
  // "resurrects" link editing and splices a link mark into unrelated text,
  // producing a broken link. So on every state update drop any pin that no
  // longer coincides with an empty caret. Our own handlers re-pin right after
  // dispatching, so this never clears a still-valid edit.
  function validateLinkEditState(view: EditorView): void {
    const { selection } = view.state;
    const caret =
      selection instanceof TextSelection && selection.empty
        ? selection.from
        : null;
    if (pendingEmptyNoteLink && pendingEmptyNoteLink.pos !== caret) {
      pendingEmptyNoteLink = null;
    }
    if (activeBoundaryLinkEdit && activeBoundaryLinkEdit.pos !== caret) {
      activeBoundaryLinkEdit = null;
    }
  }

  function build(
    doc: Parameters<typeof DecorationSet.create>[0]
  ): DecorationSet {
    const decos: Decoration[] = [];
    // descendants over textblocks; wikilinks span only text within one
    // block (the regex forbids \n).
    doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return;
      const text = node.text;
      const noteLinkMark = node.marks.find((mark) =>
        parseNoteHref(mark.attrs.href)
      );
      const noteId = parseNoteHref(noteLinkMark?.attrs.href);
      if (noteId) {
        const title = resolveNoteTitleById(noteId, text.trim() || text);
        decos.push(
          Decoration.inline(pos, pos + text.length, {
            class: 'wikilink wikilink-note-link',
            'data-note-id': noteId,
            'data-wikilink-title': title
          })
        );
        return;
      }

      let m: RegExpExecArray | null;
      WIKILINK_RE.lastIndex = 0;
      while ((m = WIKILINK_RE.exec(text)) !== null) {
        const from = pos + m.index;
        const to = from + m[0].length;
        const title = m[1].trim();
        const id = resolveNoteIdByTitle(title);
        const attrs: Record<string, string> = {
          class: 'wikilink wikilink-legacy',
          'data-wikilink-title': title
        };
        if (id) attrs['data-note-id'] = id;
        decos.push(Decoration.inline(from, to, attrs));
      }
    });
    return DecorationSet.create(doc, decos);
  }

  return new Plugin({
    key: decorationPluginKey,
    view(view) {
      const suppressHoverTooltip = (event: MouseEvent) => {
        if (!closestNoteLinkElement(event.target)) return;
        hideNativeNoteLinkTooltipsSoon();
        event.stopImmediatePropagation();
      };

      const hideTooltip = (event: MouseEvent) => {
        if (!closestNoteLinkElement(event.target)) return;
        hideNativeNoteLinkTooltipsSoon();
      };

      // Note links render as real `<a href="mindstream://note/…">`
      // anchors. `handleClick` preventDefaults on the paths where it
      // opens the note, but its early returns (note not resolved, plain
      // click with open-on-click off) don't — leaving the browser to
      // follow the href. On the Android WebView that navigates the whole
      // page to the unresolvable custom scheme and white-screens the app.
      // Cancel the default navigation for every note-link anchor here,
      // unconditionally and in the capture phase (before the anchor's own
      // default action). preventDefault only stops the navigation; it
      // doesn't stop `handleClick` from still running to open the note.
      const preventNoteLinkNavigation = (event: MouseEvent) => {
        if (closestNoteLinkElement(event.target)) event.preventDefault();
      };

      view.dom.addEventListener('mousemove', suppressHoverTooltip, true);
      view.dom.addEventListener('mouseover', suppressHoverTooltip, true);
      view.dom.addEventListener('mousedown', hideTooltip, true);
      view.dom.addEventListener('click', hideTooltip, true);
      view.dom.addEventListener('click', preventNoteLinkNavigation, true);

      return {
        update(view) {
          validateLinkEditState(view);
          syncBoundaryMode(view);
        },
        destroy() {
          view.dom.removeEventListener('mousemove', suppressHoverTooltip, true);
          view.dom.removeEventListener('mouseover', suppressHoverTooltip, true);
          view.dom.removeEventListener('mousedown', hideTooltip, true);
          view.dom.removeEventListener('click', hideTooltip, true);
          view.dom.removeEventListener(
            'click',
            preventNoteLinkNavigation,
            true
          );
          view.dom.classList.remove(
            'wikilink-boundary-inside',
            'wikilink-boundary-outside',
            'wikilink-boundary-start',
            'wikilink-boundary-end'
          );
          delete view.dom.dataset.wikilinkBoundary;
          delete view.dom.dataset.wikilinkBoundarySide;
        }
      };
    },
    state: {
      init(_, state) {
        return build(state.doc);
      },
      apply(tr, prev) {
        if (!tr.docChanged) return prev;
        return build(tr.doc);
      }
    },
    props: {
      decorations(state) {
        return decorationPluginKey.getState(state);
      },
      handleTextInput(view, from, to, text) {
        if (
          activeBoundaryLinkEdit &&
          from === to &&
          from === activeBoundaryLinkEdit.pos
        ) {
          // Capture the mark before dispatching: insertLinkBoundaryText
          // moves the caret, which makes validateLinkEditState (run from
          // the view-update hook during dispatch) null the pin. Reading
          // it afterwards used to throw, abort the re-pin, and dump the
          // very next character outside the link.
          const mark = activeBoundaryLinkEdit.mark;
          const nextPos = insertLinkBoundaryText(view, from, text, mark);
          if (nextPos !== null) {
            pendingEmptyNoteLink = null;
            setActiveBoundaryLinkEdit(view, { pos: nextPos, mark });
            return true;
          }
        }

        if (
          pendingEmptyNoteLink &&
          from === to &&
          from === pendingEmptyNoteLink.pos
        ) {
          // Same capture-before-dispatch dance as above.
          const mark = pendingEmptyNoteLink.mark;
          const nextPos = insertLinkBoundaryText(view, from, text, mark);
          pendingEmptyNoteLink = null;
          if (nextPos !== null) {
            setActiveBoundaryLinkEdit(view, { pos: nextPos, mark });
            return true;
          }
        }

        pendingEmptyNoteLink = null;
        const typedOutside = typeOutsideLinkBoundary(view, from, to, text);
        if (typedOutside) setActiveBoundaryLinkEdit(view, null);
        return typedOutside;
      },
      handleClick(view, _pos, event) {
        // Clicking never enters link-text editing; the caret lands "outside"
        // the link on either side. Editing is opt-in via arrow keys, which
        // keeps left/right click behavior identical regardless of where the
        // link sits in the line.
        clearLinkEditState(view);

        // Ctrl/Cmd always opens. Plain left click opens when the user
        // opts into note links behaving like ordinary navigation.
        const openModifier = event.metaKey || event.ctrlKey;
        const plainClick =
          event.button === 0 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey;
        if (!openModifier && !(plainClick && options.openOnClick())) {
          return false;
        }
        const target = event.target;
        if (!(target instanceof Element)) return false;
        const linkEl = target.closest('.wikilink');
        if (!linkEl) return false;
        const noteId = linkEl.getAttribute('data-note-id');
        if (
          noteId &&
          tree.notesById[noteId] &&
          !tree.notesById[noteId].trashed
        ) {
          event.preventDefault();
          bridge.cancel();
          requestOpenNote(noteId);
          return true;
        }
        const title = linkEl.getAttribute('data-wikilink-title');
        if (!title) return false;
        const id = resolveNoteIdByTitle(title);
        if (!id) {
          // Don't suppress the click — let the cursor land so the
          // user can rename / create the missing target. A future
          // iteration could prompt to create on Cmd-click.
          return false;
        }
        event.preventDefault();
        bridge.cancel();
        requestOpenNote(id);
        return true;
      },
      handleKeyDown(view, event) {
        if (event.key === 'Backspace' || event.key === 'Delete') {
          if (removeAdjacentNoteLink(view, event, boundaryMode(view))) {
            clearLinkEditState(view);
            return true;
          }
          if (wholeNoteLinkDeletion(view.state, event)) {
            event.preventDefault();
            pendingEmptyNoteLink = deleteNoteLinkText(view, event);
            setActiveBoundaryLinkEdit(view, null);
            syncBoundaryMode(view);
            return !!pendingEmptyNoteLink;
          }
          if (activeBoundaryLinkEdit) {
            const next = deleteInsideLinkBoundary(
              view,
              event,
              activeBoundaryLinkEdit
            );
            if (next) {
              event.preventDefault();
              pendingEmptyNoteLink = null;
              setActiveBoundaryLinkEdit(view, next);
              return true;
            }
          }
          return false;
        }

        const toggled = toggleLinkBoundaryEditing(
          view,
          event,
          activeBoundaryLinkEdit
        );
        if (toggled) {
          pendingEmptyNoteLink = null;
          setActiveBoundaryLinkEdit(view, toggled === 'exit' ? null : toggled);
          return true;
        }
        const arrowed = arrowWithinLinkText(
          view,
          event,
          activeBoundaryLinkEdit
        );
        if (arrowed) {
          event.preventDefault();
          pendingEmptyNoteLink = null;
          setActiveBoundaryLinkEdit(view, arrowed);
          return true;
        }
        if (event.key.startsWith('Arrow')) {
          clearLinkEditState(view);
        }
        return false;
      }
    }
  });
}

/* --- Public factory ------------------------------------------------------- */

/**
 * Two `$prose` plugins wrapped as one Milkdown plugin array. Crepe's
 * `.use(...)` accepts arrays so this drops in the same way as our
 * other local plugins (see `crepe-setup.ts`).
 *
 * The decoration + click handler runs unconditionally once enabled —
 * even when the menu isn't open, the doc still has wikilinks the user
 * might want to click. The trigger plugin is the only one that needs
 * the per-editor bridge.
 */
export function wikilinkPlugins(
  bridge: WikilinkBridge,
  options: WikilinkPluginOptions
) {
  return [
    $prose(() => wikilinkTriggerPlugin(bridge)),
    $prose(() => wikilinkDecorationPlugin(bridge, options))
  ];
}
