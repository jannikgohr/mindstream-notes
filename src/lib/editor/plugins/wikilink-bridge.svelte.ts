/**
 * Per-editor reactive state shared between the wikilink prose plugin
 * (`./wikilink.ts`) and the popup component (`WikilinkMenu.svelte`).
 *
 * Lives in a `.svelte.ts` file because it uses the `$state` rune —
 * Svelte's compiler only processes runes in `.svelte` / `.svelte.ts`
 * files. The prose plugin itself stays in plain `.ts` so it can import
 * Milkdown's `$prose` helper (the `$` prefix is reserved inside
 * `.svelte.ts`, so importing `$prose` there fails at compile time).
 *
 * Mutability contract — both sides honour these so neither has to
 * defend against the other writing unexpected fields:
 *   - Plugin writes:   open, query, anchor (via the trigger plugin's
 *                      `view.update` hook)
 *   - Plugin reads:    highlight (only when committing)
 *   - Plugin calls:    setHandlers (once on attach)
 *   - Popup writes:    highlight
 *   - Popup reads:     open, query, anchor
 *   - Popup calls:     insert, cancel
 *   - Popup calls:     setCommitFromPopup (once on mount)
 */

import type { CaretRect } from './prose/typeahead';
import { createTypeaheadHandlers } from './typeahead-bridge';
export type { CaretRect } from './prose/typeahead';

export interface WikilinkBridge {
  state: {
    open: boolean;
    /** Text between the `[[` and the cursor — popup filter input. */
    query: string;
    /** Caret rect for floating-ui positioning; null when menu is closed. */
    caretRect: CaretRect | null;
    /** Index in the popup's filtered list currently highlighted. */
    highlight: number;
  };
  /**
   * Popup calls this to commit a selected note. Plugin replaces the
   * `[[query` (and a trailing `]]` if auto-paired) with an ID-backed
   * markdown link mark, places the cursor after it, and closes the menu.
   * Wired by the plugin via `setHandlers`.
   */
  insert(note: { id: string; title: string }): void;
  /** Closes the menu without inserting. Wired by the plugin. */
  cancel(): void;
  /** Plugin invokes when the user presses Enter inside the editor while
   *  the menu is open — popup uses it to commit its highlighted item. */
  commitFromPopup(): void;
  /** Plugin → bridge wiring (called once when the plugin attaches). */
  setHandlers(handlers: {
    insert: (note: { id: string; title: string }) => void;
    cancel: () => void;
  }): void;
  /** Popup → bridge wiring (called when the popup mounts). */
  setCommitFromPopup(commit: () => void): void;
}

export function createWikilinkBridge(): WikilinkBridge {
  const state = $state({
    open: false,
    query: '',
    caretRect: null as CaretRect | null,
    highlight: 0
  });

  return createTypeaheadHandlers(
    state,
    (_note: { id: string; title: string }) => {}
  );
}
