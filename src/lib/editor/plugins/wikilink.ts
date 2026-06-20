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
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { requestOpenNote } from '$lib/stores/open-note-intent.svelte';
import { tree } from '$lib/stores/tree.svelte';
import type { WikilinkBridge } from './wikilink-bridge.svelte';

// Re-export so consumers can still get everything wikilink-related
// through this one module — the bridge factory lives in its own
// .svelte.ts because Svelte's compiler treats the `$` prefix as
// reserved in .svelte.ts files, which would block this file's
// `import { $prose } from '@milkdown/kit/utils'`.
export type { WikilinkBridge } from './wikilink-bridge.svelte';
export { createWikilinkBridge } from './wikilink-bridge.svelte';

/* --- Note link resolution -------------------------------------------------- */

const NOTE_LINK_PREFIX = 'mindstream://note/';

export function noteHref(noteId: string): string {
  return `${NOTE_LINK_PREFIX}${encodeURIComponent(noteId)}`;
}

function parseNoteHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  if (!href.startsWith(NOTE_LINK_PREFIX)) return null;
  const raw = href.slice(NOTE_LINK_PREFIX.length);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

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

interface WikilinkPluginOptions {
  openOnClick: () => boolean;
}

function wikilinkDecorationPlugin(
  bridge: WikilinkBridge,
  options: WikilinkPluginOptions
): Plugin {
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

      view.dom.addEventListener('mousemove', suppressHoverTooltip, true);
      view.dom.addEventListener('mouseover', suppressHoverTooltip, true);
      view.dom.addEventListener('mousedown', hideTooltip, true);
      view.dom.addEventListener('click', hideTooltip, true);

      return {
        destroy() {
          view.dom.removeEventListener('mousemove', suppressHoverTooltip, true);
          view.dom.removeEventListener('mouseover', suppressHoverTooltip, true);
          view.dom.removeEventListener('mousedown', hideTooltip, true);
          view.dom.removeEventListener('click', hideTooltip, true);
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
      handleClick(_view, _pos, event) {
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
