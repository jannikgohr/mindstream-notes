/**
 * Per-editor reactive state shared between the markdown find/replace prose
 * plugin (`./markdown-search.ts`) and the host component
 * (`NoteEditor.svelte`, which drives the shared `FindBar`).
 *
 * Lives in a `.svelte.ts` file because it uses the `$state` rune — the
 * prose plugin itself stays in plain `.ts` so it can import Milkdown's
 * `$prose` helper (the `$` prefix is reserved inside `.svelte.ts`). Same
 * split as the wikilink bridge; see `./wikilink-bridge.svelte.ts`.
 *
 * Mutability contract:
 *   - Plugin writes:   matchCount, activeIndex (via the plugin's
 *                      `view.update` hook, on every transaction)
 *   - Component reads: matchCount, activeIndex
 *   - Component calls: setQuery / next / previous / replaceCurrent /
 *                      replaceAll / focusActive / clear
 *   - Plugin calls:    setHandlers (once on attach)
 */

/**
 * VS Code-style search/replace modifiers. Re-declared here (rather than
 * imported from `./markdown-search`) so this `.svelte.ts` module stays free
 * of the prose-plugin import graph; the shapes are kept in sync by the
 * `setOptions` contract.
 */
export interface MarkdownSearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  preserveCase: boolean;
}

export interface MarkdownSearchHandlers {
  /** Set (or update) the query and recompute matches. Empty string clears. */
  setQuery(query: string): void;
  /** Update the case/word/regex/preserve-case modifiers and recompute. */
  setOptions(options: MarkdownSearchOptions): void;
  /** Move the active match forward, wrapping past the end. */
  next(): void;
  /** Move the active match backward, wrapping past the start. */
  previous(): void;
  /** Replace the current (active) match, then advance to the next one. */
  replaceCurrent(replacement: string): void;
  /** Replace every match in one undoable step. */
  replaceAll(replacement: string): void;
  /** Re-scroll/select the active match (used when (re)opening the bar). */
  focusActive(): void;
  /** Drop all matches + decorations (on close). */
  clear(): void;
}

export interface MarkdownSearchBridge extends MarkdownSearchHandlers {
  state: {
    /** Total number of matches for the current query. */
    matchCount: number;
    /** Zero-based index of the active match (0 when there are none). */
    activeIndex: number;
  };
  /** Plugin → bridge wiring (called once when the plugin attaches). */
  setHandlers(handlers: MarkdownSearchHandlers): void;
}

export function createMarkdownSearchBridge(): MarkdownSearchBridge {
  const state = $state({ matchCount: 0, activeIndex: 0 });

  // Stub callables so the component can call through without null checks
  // even before the plugin has attached. Replaced via setHandlers.
  let handlers: MarkdownSearchHandlers = {
    setQuery: () => {},
    setOptions: () => {},
    next: () => {},
    previous: () => {},
    replaceCurrent: () => {},
    replaceAll: () => {},
    focusActive: () => {},
    clear: () => {}
  };

  return {
    state,
    setQuery: (query) => handlers.setQuery(query),
    setOptions: (options) => handlers.setOptions(options),
    next: () => handlers.next(),
    previous: () => handlers.previous(),
    replaceCurrent: (replacement) => handlers.replaceCurrent(replacement),
    replaceAll: (replacement) => handlers.replaceAll(replacement),
    focusActive: () => handlers.focusActive(),
    clear: () => handlers.clear(),
    setHandlers(next) {
      handlers = next;
    }
  };
}
