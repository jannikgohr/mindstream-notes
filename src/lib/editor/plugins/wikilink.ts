/**
 * Wikilinks — `[[Note Title]]` references that pop up a note picker as
 * the user types and decorate already-typed links as clickable.
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
 *   2. **Decoration plugin** — scans the doc for `[[ ... ]]` spans and
 *      wraps each one in a `.wikilink` inline decoration. The
 *      markdown itself stays as `[[Title]]` (commonmark serialises it
 *      verbatim) — the decoration is purely visual, so reload + sync
 *      both round-trip without any schema change.
 *
 *   3. **Click handler** — Cmd/Ctrl+click on a `.wikilink` resolves the
 *      title against the note tree and dispatches `requestOpenNote`.
 *      Plain click is left to ProseMirror so the user can still place
 *      the cursor inside a wikilink to edit it.
 *
 * The trigger plugin and the popup component share a `WikilinkBridge`
 * object that NoteEditor creates per editor instance. The bridge is how
 * the plugin says "menu just opened with this query" and the popup says
 * "user picked this title" without either side reaching into the other's
 * implementation. Per-editor (not module-level) so two open notes don't
 * fight over a single popup.
 */

import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
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

/* --- Title → noteId resolution -------------------------------------------- */

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

const triggerPluginKey = new PluginKey<TriggerState>('mindstream-wikilink-trigger');

/**
 * Maximum query length — closes the menu if the user types something
 * absurd. Stops a runaway "I forgot to close my brackets" from holding
 * the menu open across the whole note.
 */
const MAX_QUERY_LEN = 80;

function wikilinkTriggerPlugin(bridge: WikilinkBridge): Plugin<TriggerState> {
  let viewRef: EditorView | null = null;

  function close() {
    bridge.state.open = false;
    bridge.state.query = '';
    bridge.state.caretRect = null;
    bridge.state.highlight = 0;
    if (viewRef) {
      viewRef.dispatch(viewRef.state.tr.setMeta(triggerPluginKey, { close: true }));
    }
  }

  function insert(title: string) {
    if (!viewRef) return;
    const view = viewRef;
    const trigger = triggerPluginKey.getState(view.state);
    const start = trigger?.startPos ?? null;
    if (start === null) {
      close();
      return;
    }
    const cursor = view.state.selection.from;
    // If auto-pair (or the user) put `]]` right after the cursor, swallow
    // it so we end up with exactly one closing pair from our insertion.
    const after = view.state.doc.textBetween(cursor, Math.min(cursor + 2, view.state.doc.content.size));
    const consumeClose = after === ']]' ? 2 : 0;
    const replacement = `[[${title}]]`;
    const tr = view.state.tr.insertText(replacement, start, cursor + consumeClose);
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
        // Explicit open/close metas trump everything.
        const meta = tr.getMeta(triggerPluginKey) as
          | { open?: number; close?: true }
          | undefined;
        if (meta?.close) return { startPos: null };
        if (meta?.open !== undefined) return { startPos: meta.open };

        if (prev.startPos === null) return prev;

        // Map the start position forward through the transaction so
        // unrelated edits earlier in the doc don't break our anchor.
        const mappedStart = tr.mapping.map(prev.startPos);
        const cursor = newState.selection.from;

        // Selection out of range (above the [[ or far past it) → close.
        if (cursor < mappedStart + 2) {
          return { startPos: null };
        }
        // Caret must remain in the same parent text-block as the [[.
        if (newState.doc.resolve(mappedStart).parent !== newState.doc.resolve(cursor).parent) {
          return { startPos: null };
        }
        const queryRaw = newState.doc.textBetween(mappedStart + 2, cursor, '\n');
        // Newline or closing brackets in the query → user committed
        // their own ending; close and let the doc text stand.
        if (queryRaw.includes('\n') || queryRaw.includes(']]') || queryRaw.includes('[[')) {
          return { startPos: null };
        }
        if (queryRaw.length > MAX_QUERY_LEN) {
          return { startPos: null };
        }
        return { startPos: mappedStart };
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
          if (viewRef === view) viewRef = null;
        }
      };
    },

    props: {
      handleTextInput(view, from, to, text) {
        // Detect `[[`: a single `[` typed when the char immediately
        // before the insertion is already `[`. Two consecutive paths
        // matter:
        //   - Auto-pair off: doc grows `[ → [[`, both chars typed
        //     normally; second `[` arrives here with prev char `[`.
        //   - Auto-pair on: the first `[` triggered auto-pair, which
        //     dispatches its own transaction. The user's second
        //     keystroke arrives here with the doc now `[|]` — same
        //     prev-char test passes.
        if (text !== '[') return false;
        if (from === 0) return false;
        const prev = view.state.doc.textBetween(from - 1, from);
        if (prev !== '[') return false;
        // The `[[` start position is one char before the just-typed `[`.
        // Schedule open on a microtask so the typed text lands first
        // and the position arithmetic still works whether or not
        // auto-pair fired in between.
        const start = from - 1;
        queueMicrotask(() => {
          const view2 = viewRef;
          if (!view2) return;
          view2.dispatch(
            view2.state.tr.setMeta(triggerPluginKey, { open: start })
          );
        });
        return false;
      },

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

function wikilinkDecorationPlugin(): Plugin {
  function build(doc: Parameters<typeof DecorationSet.create>[0]): DecorationSet {
    const decos: Decoration[] = [];
    // descendants over textblocks; wikilinks span only text within one
    // block (the regex forbids \n).
    doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return;
      const text = node.text;
      let m: RegExpExecArray | null;
      WIKILINK_RE.lastIndex = 0;
      while ((m = WIKILINK_RE.exec(text)) !== null) {
        const from = pos + m.index;
        const to = from + m[0].length;
        const title = m[1].trim();
        decos.push(
          Decoration.inline(from, to, {
            class: 'wikilink',
            'data-wikilink-title': title
          })
        );
      }
    });
    return DecorationSet.create(doc, decos);
  }

  return new Plugin({
    key: decorationPluginKey,
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
        // Open-on-modifier so plain click still places the cursor
        // (you need to be able to edit a typo'd title). Cmd on macOS,
        // Ctrl elsewhere — same convention as VS Code "Go to definition".
        const openModifier = event.metaKey || event.ctrlKey;
        if (!openModifier) return false;
        const target = event.target;
        if (!(target instanceof Element)) return false;
        const linkEl = target.closest('.wikilink');
        if (!linkEl) return false;
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
export function wikilinkPlugins(bridge: WikilinkBridge) {
  return [
    $prose(() => wikilinkTriggerPlugin(bridge)),
    $prose(() => wikilinkDecorationPlugin())
  ];
}
