/**
 * Per-editor reactive state shared between the user-mention prose plugin
 * (`./user-mention.ts`) and the popup component (`UserMentionMenu.svelte`).
 *
 * Sibling of `./wikilink-bridge.svelte.ts` — same rationale for living in a
 * `.svelte.ts` file (uses the `$state` rune; the prose plugin stays in plain
 * `.ts` so it can import Milkdown's `$prose` helper, whose `$` prefix is
 * reserved inside `.svelte.ts`).
 *
 * One extra field over the wikilink bridge: `users`. Wikilink candidates come
 * from the synchronous `tree` store, but the mention candidates ("who can view
 * this note") require an async backend call, so `NoteEditor` resolves them and
 * writes them here; the popup just filters this list by `query`.
 *
 * Mutability contract:
 *   - Plugin writes:   open, query, caretRect (via the trigger plugin's
 *                      `view.update` hook)
 *   - Plugin reads:    highlight (only when committing)
 *   - Plugin calls:    setHandlers (once on attach)
 *   - Host writes:     users (NoteEditor, when the share state resolves)
 *   - Popup writes:    highlight
 *   - Popup reads:     open, query, caretRect, users
 *   - Popup calls:     insert, cancel, setCommitFromPopup (once on mount)
 */

import type { CollectionShareAccessLevel } from '$lib/api/sharing';

/**
 * Caret rectangle in viewport coordinates — see the identical type in
 * `./wikilink-bridge.svelte.ts` for the floating-ui rationale.
 */
export interface CaretRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** A user offered by the mention dropdown. */
export interface MentionUser {
  username: string;
  /** Access level within the note's share scope; null for the owner/self. */
  accessLevel: CollectionShareAccessLevel | null;
  /** True when this is the signed-in user — drives the "self" highlight. */
  isSelf: boolean;
}

export interface UserMentionBridge {
  state: {
    open: boolean;
    /** Text between the `@` and the cursor — popup filter input. */
    query: string;
    /** Caret rect for floating-ui positioning; null when menu is closed. */
    caretRect: CaretRect | null;
    /** Index in the popup's filtered list currently highlighted. */
    highlight: number;
    /** Candidates who can view the note. Populated by the host (NoteEditor). */
    users: MentionUser[];
  };
  /**
   * Popup calls this to commit a selected user. Plugin replaces the
   * `@query` with an ID-backed markdown link mark (`@username` →
   * `mindstream://user/<username>`), places the cursor after it, and closes
   * the menu. Wired by the plugin via `setHandlers`.
   */
  insert(user: { username: string }): void;
  /** Closes the menu without inserting. Wired by the plugin. */
  cancel(): void;
  /** Plugin invokes when the user presses Enter inside the editor while
   *  the menu is open — popup uses it to commit its highlighted item. */
  commitFromPopup(): void;
  /** Plugin → bridge wiring (called once when the plugin attaches). */
  setHandlers(handlers: {
    insert: (user: { username: string }) => void;
    cancel: () => void;
  }): void;
  /** Popup → bridge wiring (called when the popup mounts). */
  setCommitFromPopup(commit: () => void): void;
}

export function createUserMentionBridge(): UserMentionBridge {
  const state = $state({
    open: false,
    query: '',
    caretRect: null as CaretRect | null,
    highlight: 0,
    users: [] as MentionUser[]
  });

  // Stub callables so both sides can call through without null checks even
  // before the other side has wired up. Replaced via the setters.
  let insertFn: (user: { username: string }) => void = () => {};
  let cancelFn: () => void = () => {};
  let commitFn: () => void = () => {};

  return {
    state,
    insert: (user) => insertFn(user),
    cancel: () => cancelFn(),
    commitFromPopup: () => commitFn(),
    setHandlers(handlers) {
      insertFn = handlers.insert;
      cancelFn = handlers.cancel;
    },
    setCommitFromPopup(commit) {
      commitFn = commit;
    }
  };
}
