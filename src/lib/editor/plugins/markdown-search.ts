/**
 * Markdown find & replace — a ProseMirror plugin that powers the
 * VS Code-style search bar (`FindBar.svelte`) for the markdown editor.
 *
 * Responsibilities:
 *   1. **Matching** — scan the doc for every occurrence of the query
 *      (honouring the case / whole-word / regex modifiers), mapping each
 *      hit back to its doc positions. Matches are scoped to a single text
 *      block, so a query never spans a paragraph boundary.
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
import { parseNoteHref } from './wikilink';
import type { MarkdownSearchBridge } from './markdown-search-bridge.svelte';

export type {
  MarkdownSearchBridge,
  MarkdownSearchOptions
} from './markdown-search-bridge.svelte';
export { createMarkdownSearchBridge } from './markdown-search-bridge.svelte';

interface SearchMatch {
  from: number;
  to: number;
}

/**
 * VS Code-style search/replace modifiers. The first three shape matching;
 * `preserveCase` only affects how replacements are cased.
 */
export interface SearchOptions {
  /** Case-sensitive matching (`Aa`). */
  caseSensitive: boolean;
  /** Only match whole words, bounded by `\b` (`ab|`). */
  wholeWord: boolean;
  /** Treat the query as a regular expression (`.*`). */
  regex: boolean;
  /** When replacing, carry the matched text's casing onto the replacement. */
  preserveCase: boolean;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  preserveCase: false
};

interface SearchPluginState {
  query: string;
  options: SearchOptions;
  matches: SearchMatch[];
  activeIndex: number;
  deco: DecorationSet;
}

type SearchMeta =
  | { type: 'setQuery'; query: string }
  | { type: 'setOptions'; options: SearchOptions }
  | { type: 'setActive'; index: number }
  | { type: 'clear' };

const searchPluginKey = new PluginKey<SearchPluginState>(
  'mindstream-markdown-search'
);

// Stand-in for a non-text inline node (e.g. an inline image) so a match
// can't silently span across it — the user's query will never contain
// this code point, so it always breaks the run.
const ATOM_SENTINEL = '￿';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile the query + options into a global RegExp, or `null` when there's
 * nothing to match (empty query) or the user typed an invalid regex (which
 * VS Code surfaces as "no results" — we do the same rather than throwing).
 */
function buildMatcher(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null;
  let pattern = options.regex ? query : escapeRegExp(query);
  if (options.wholeWord) pattern = `\\b(?:${pattern})\\b`;
  const flags = options.caseSensitive ? 'g' : 'gi';
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/**
 * Re-case `replacement` to match `source`'s casing pattern — the
 * "Preserve Case" behaviour. All-upper → upper, all-lower → lower,
 * Title-case → title-case; anything mixed is left as the user typed it.
 *
 * Exported for unit testing; the plugin's replace paths are the only
 * runtime callers.
 */
export function applyPreservedCase(
  source: string,
  replacement: string
): string {
  if (!source || !replacement) return replacement;
  const lower = source.toLowerCase();
  const upper = source.toUpperCase();
  if (source === upper && source !== lower) return replacement.toUpperCase();
  if (source === lower) return replacement.toLowerCase();
  const firstIsUpper = source[0] === source[0].toUpperCase();
  const restIsLower = source.slice(1) === source.slice(1).toLowerCase();
  if (firstIsUpper && restIsLower) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * Find every occurrence of `query` (honouring `options`), scoped per text
 * block. Returns matches in document order. Each match is a half-open
 * `{ from, to }` doc range.
 *
 * Exported for unit testing; the plugin is the only runtime caller.
 */
export function findMatches(
  doc: ProseNode,
  query: string,
  options: SearchOptions = DEFAULT_SEARCH_OPTIONS
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  const matcher = buildMatcher(query, options);
  if (!matcher) return matches;

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

    matcher.lastIndex = 0;
    let m: RegExpExecArray | null = matcher.exec(text);
    while (m !== null) {
      const len = m[0].length;
      if (len === 0) {
        // Zero-width match (e.g. a regex like `a*`) — step forward so the
        // loop can't spin forever on the same position.
        matcher.lastIndex += 1;
      } else {
        matches.push({
          from: posMap[m.index],
          to: posMap[m.index + len - 1] + 1
        });
      }
      m = matcher.exec(text);
    }
    // Inline content already handled; no need to descend into text nodes.
    return false;
  });

  return matches;
}

/**
 * Contiguous ranges covered by an id-backed note-link mark
 * (`mindstream://note/…`), with adjacent same-href text nodes merged into
 * one range. These links render their `[[`/`]]` as CSS pseudo-elements on a
 * single `.wikilink-note-link` span, so a highlight that splits the span
 * would repeat the brackets mid-link (`[[Test]][[ Note]]`). Legacy
 * `[[Title]]` links keep literal brackets in their text and don't have this
 * problem, so they're intentionally excluded.
 */
export function collectNoteLinkRanges(doc: ProseNode): SearchMatch[] {
  const ranges: { from: number; to: number; href: string }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const mark = node.marks.find((m) => parseNoteHref(m.attrs.href));
    const href = mark?.attrs.href;
    if (typeof href !== 'string') return;
    const last = ranges[ranges.length - 1];
    if (last && last.href === href && last.to === pos) {
      last.to = pos + node.text.length;
    } else {
      ranges.push({ from: pos, to: pos + node.text.length, href });
    }
  });
  return ranges.map(({ from, to }) => ({ from, to }));
}

/**
 * Grow a match range so it fully covers any note link it touches — the
 * highlight then lands on the whole `.wikilink-note-link` span instead of
 * carving it in two (which would duplicate the bracket pseudo-elements).
 */
export function snapRangeToNoteLinks(
  match: SearchMatch,
  linkRanges: SearchMatch[]
): SearchMatch {
  let { from, to } = match;
  for (const link of linkRanges) {
    if (link.from < to && link.to > from) {
      if (link.from < from) from = link.from;
      if (link.to > to) to = link.to;
    }
  }
  return { from, to };
}

function buildDecorations(
  doc: ProseNode,
  matches: SearchMatch[],
  activeIndex: number
): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty;
  const linkRanges = collectNoteLinkRanges(doc);
  const decos = matches.map((match, i) => {
    const range = linkRanges.length
      ? snapRangeToNoteLinks(match, linkRanges)
      : match;
    return Decoration.inline(range.from, range.to, {
      class:
        i === activeIndex ? 'search-match search-match-active' : 'search-match'
    });
  });
  return DecorationSet.create(doc, decos);
}

function clampIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return ((index % length) + length) % length;
}

const EMPTY_STATE: SearchPluginState = {
  query: '',
  options: DEFAULT_SEARCH_OPTIONS,
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

  function setOptions(options: SearchOptions) {
    const view = viewRef;
    if (!view) return;
    view.dispatch(
      view.state.tr.setMeta(searchPluginKey, { type: 'setOptions', options })
    );
    // Toggling case/word/regex re-shapes the match set; re-anchor to the
    // first hit so the active highlight isn't pointing at a stale index.
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

  /** The replacement to actually insert for a given match, applying
   *  Preserve Case against the match's current text when enabled. */
  function resolveReplacement(
    view: EditorView,
    match: SearchMatch,
    replacement: string,
    options: SearchOptions
  ): string {
    if (!options.preserveCase) return replacement;
    const source = view.state.doc.textBetween(match.from, match.to);
    return applyPreservedCase(source, replacement);
  }

  function replaceCurrent(replacement: string) {
    const view = viewRef;
    const st = getState();
    if (!view || !st || st.matches.length === 0) return;
    const index = st.activeIndex;
    const match = st.matches[index];
    const tr = view.state.tr;
    replaceRange(
      tr,
      match.from,
      match.to,
      resolveReplacement(view, match, replacement, st.options)
    );
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
    // the positions of the matches we haven't touched yet. Per-match
    // casing is read from the original doc (the loop hasn't dispatched).
    for (let i = st.matches.length - 1; i >= 0; i -= 1) {
      const match = st.matches[i];
      replaceRange(
        tr,
        match.from,
        match.to,
        resolveReplacement(view, match, replacement, st.options)
      );
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
    setOptions,
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
        let options = prev.options;
        let activeIndex = prev.activeIndex;
        let recompute = tr.docChanged;

        if (meta?.type === 'setQuery') {
          query = meta.query;
          activeIndex = 0;
          recompute = true;
        } else if (meta?.type === 'setOptions') {
          options = meta.options;
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

        const matches = findMatches(newState.doc, query, options);
        const clamped =
          matches.length === 0
            ? 0
            : Math.min(Math.max(activeIndex, 0), matches.length - 1);
        return {
          query,
          options,
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
