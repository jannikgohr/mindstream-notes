/**
 * Markdown find & replace — a ProseMirror plugin that powers the
 * VS Code-style search bar (`FindBar.svelte`) for the markdown editor.
 *
 * Responsibilities:
 *   1. **Matching** — scan the doc for every (case-insensitive) occurrence
 *      of the query, mapping each hit back to its doc positions. Matches
 *      are scoped to a single text block, so a query never spans a
 *      paragraph boundary.
 *   2. **Decoration** — highlight every match, with the active one styled
 *      distinctly (`.search-match` / `.search-match-active`, see app.css).
 *   3. **Navigation** — next/previous wrap around and scroll+select the
 *      active hit so Replace acts on what the user sees.
 *   4. **Replace** — replace the active match (then advance) or every
 *      match in one undoable transaction.
 *
 * State flows out to the host via a per-editor `MarkdownSearchBridge`
 * (match count + active index, written in the plugin's `view.update`);
 * commands flow in via the bridge's handler functions, which the plugin
 * wires on attach. Same bridge pattern as the wikilink plugin.
 */

import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction
} from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { $prose } from '@milkdown/kit/utils';
import type { MarkdownSearchBridge } from './markdown-search-bridge.svelte';

export type { MarkdownSearchBridge } from './markdown-search-bridge.svelte';
export { createMarkdownSearchBridge } from './markdown-search-bridge.svelte';

interface SearchMatch {
  from: number;
  to: number;
}

interface SearchPluginState {
  query: string;
  matches: SearchMatch[];
  activeIndex: number;
  deco: DecorationSet;
}

type SearchMeta =
  | { type: 'setQuery'; query: string }
  | { type: 'setActive'; index: number }
  | { type: 'clear' };

const searchPluginKey = new PluginKey<SearchPluginState>(
  'mindstream-markdown-search'
);

// Stand-in for a non-text inline node (e.g. an inline image) so a match
// can't silently span across it — the user's query will never contain
// this code point, so it always breaks the run.
const ATOM_SENTINEL = '￿';

/**
 * Find every case-insensitive occurrence of `query`, scoped per text
 * block. Returns matches in document order. Each match is a half-open
 * `{ from, to }` doc range.
 *
 * Exported for unit testing; the plugin is the only runtime caller.
 */
export function findMatches(doc: ProseNode, query: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  if (!query) return matches;
  const needle = query.toLowerCase();
  const nlen = needle.length;

  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // Build the block's inline text plus a per-character map back to doc
    // positions, so a match found in the string resolves to real
    // positions even across mark boundaries (e.g. partially-bold text).
    let text = '';
    const posMap: number[] = [];
    node.forEach((child, offset) => {
      if (child.isText && child.text) {
        const t = child.text;
        for (let i = 0; i < t.length; i += 1) {
          text += t[i];
          posMap.push(pos + 1 + offset + i);
        }
      } else {
        text += ATOM_SENTINEL;
        posMap.push(pos + 1 + offset);
      }
    });

    const haystack = text.toLowerCase();
    let searchFrom = 0;
    let idx = haystack.indexOf(needle, searchFrom);
    while (idx !== -1) {
      matches.push({
        from: posMap[idx],
        to: posMap[idx + nlen - 1] + 1
      });
      searchFrom = idx + nlen;
      idx = haystack.indexOf(needle, searchFrom);
    }
    // Inline content already handled; no need to descend into text nodes.
    return false;
  });

  return matches;
}

function buildDecorations(
  doc: ProseNode,
  matches: SearchMatch[],
  activeIndex: number
): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty;
  const decos = matches.map((match, i) =>
    Decoration.inline(match.from, match.to, {
      class:
        i === activeIndex ? 'search-match search-match-active' : 'search-match'
    })
  );
  return DecorationSet.create(doc, decos);
}

function clampIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return ((index % length) + length) % length;
}

const EMPTY_STATE: SearchPluginState = {
  query: '',
  matches: [],
  activeIndex: 0,
  deco: DecorationSet.empty
};

function markdownSearchProsePlugin(
  bridge: MarkdownSearchBridge
): Plugin<SearchPluginState> {
  let viewRef: EditorView | null = null;

  function getState(): SearchPluginState | undefined {
    return viewRef ? searchPluginKey.getState(viewRef.state) : undefined;
  }

  /** Scroll+select the match at `index` (wrapped) and mark it active. */
  function focusMatch(index: number) {
    const view = viewRef;
    const st = getState();
    if (!view || !st || st.matches.length === 0) return;
    const wrapped = clampIndex(index, st.matches.length);
    const match = st.matches[wrapped];
    const tr = view.state.tr
      .setMeta(searchPluginKey, { type: 'setActive', index: wrapped })
      .setSelection(TextSelection.create(view.state.doc, match.from, match.to))
      .scrollIntoView();
    view.dispatch(tr);
  }

  function setQuery(query: string) {
    const view = viewRef;
    if (!view) return;
    view.dispatch(
      view.state.tr.setMeta(searchPluginKey, { type: 'setQuery', query })
    );
    // Land on (and scroll to) the first match for the fresh query.
    focusMatch(0);
  }

  function next() {
    const st = getState();
    if (st) focusMatch(st.activeIndex + 1);
  }

  function previous() {
    const st = getState();
    if (st) focusMatch(st.activeIndex - 1);
  }

  function replaceRange(
    tr: Transaction,
    from: number,
    to: number,
    replacement: string
  ) {
    // insertText throws on an empty string ("Empty text node"); a blank
    // replacement is a deletion.
    if (replacement) tr.insertText(replacement, from, to);
    else tr.delete(from, to);
  }

  function replaceCurrent(replacement: string) {
    const view = viewRef;
    const st = getState();
    if (!view || !st || st.matches.length === 0) return;
    const index = st.activeIndex;
    const match = st.matches[index];
    const tr = view.state.tr;
    replaceRange(tr, match.from, match.to, replacement);
    view.dispatch(tr);
    // Matches recomputed against the new doc; the hit now sitting at the
    // same index is the following occurrence — VS Code's behaviour.
    focusMatch(index);
  }

  function replaceAll(replacement: string) {
    const view = viewRef;
    const st = getState();
    if (!view || !st || st.matches.length === 0) return;
    const tr = view.state.tr;
    // Back-to-front so each replacement's length change can't invalidate
    // the positions of the matches we haven't touched yet.
    for (let i = st.matches.length - 1; i >= 0; i -= 1) {
      const match = st.matches[i];
      replaceRange(tr, match.from, match.to, replacement);
    }
    view.dispatch(tr);
  }

  function focusActive() {
    const st = getState();
    if (st) focusMatch(st.activeIndex);
  }

  function clear() {
    const view = viewRef;
    if (!view) return;
    view.dispatch(view.state.tr.setMeta(searchPluginKey, { type: 'clear' }));
  }

  bridge.setHandlers({
    setQuery,
    next,
    previous,
    replaceCurrent,
    replaceAll,
    focusActive,
    clear
  });

  return new Plugin<SearchPluginState>({
    key: searchPluginKey,
    state: {
      init: () => EMPTY_STATE,
      apply(tr, prev, _oldState, newState): SearchPluginState {
        const meta = tr.getMeta(searchPluginKey) as SearchMeta | undefined;

        if (meta?.type === 'clear') return EMPTY_STATE;

        let query = prev.query;
        let activeIndex = prev.activeIndex;
        let recompute = tr.docChanged;

        if (meta?.type === 'setQuery') {
          query = meta.query;
          activeIndex = 0;
          recompute = true;
        } else if (meta?.type === 'setActive') {
          activeIndex = meta.index;
        }

        if (!recompute) {
          // Selection-only change (e.g. navigation) — keep matches, just
          // restyle so the active highlight follows activeIndex.
          if (activeIndex === prev.activeIndex) return prev;
          return {
            ...prev,
            activeIndex,
            deco: buildDecorations(newState.doc, prev.matches, activeIndex)
          };
        }

        const matches = findMatches(newState.doc, query);
        const clamped =
          matches.length === 0
            ? 0
            : Math.min(Math.max(activeIndex, 0), matches.length - 1);
        return {
          query,
          matches,
          activeIndex: clamped,
          deco: buildDecorations(newState.doc, matches, clamped)
        };
      }
    },
    view(view) {
      viewRef = view;
      // Seed the bridge with the initial (empty) state.
      bridge.state.matchCount = 0;
      bridge.state.activeIndex = 0;
      return {
        update(updatedView) {
          const st = searchPluginKey.getState(updatedView.state);
          if (!st) return;
          const count = st.matches.length;
          if (bridge.state.matchCount !== count) {
            bridge.state.matchCount = count;
          }
          const active = count > 0 ? st.activeIndex : 0;
          if (bridge.state.activeIndex !== active) {
            bridge.state.activeIndex = active;
          }
        },
        destroy() {
          if (viewRef === view) viewRef = null;
        }
      };
    },
    props: {
      decorations(state: EditorState) {
        return searchPluginKey.getState(state)?.deco ?? DecorationSet.empty;
      }
    }
  });
}

/**
 * Public factory — wraps the prose plugin as a Milkdown plugin so it drops
 * into `crepe.editor.use(...)` (see `crepe-setup.ts`). The plugin needs the
 * per-editor bridge to report match counts and receive commands.
 */
export function markdownSearchPlugins(bridge: MarkdownSearchBridge) {
  return [$prose(() => markdownSearchProsePlugin(bridge))];
}
