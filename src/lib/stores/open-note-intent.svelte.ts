/**
 * Cross-component intent bus for "open this note".
 *
 * The dockview / tab plumbing that actually opens notes lives in the
 * layout shells (DesktopLayout, MobileLayout, SingleNoteWindow). A piece
 * of code buried deep in an editor — a wikilink click, for instance —
 * has no reasonable way to prop-drill up to those shells, and we don't
 * want a global `window.__openNote` either. So: a tiny module-level
 * subscriber set. Editors fire `requestOpenNote(id)`; the active shell
 * (subscribed in onMount) receives the id and routes it through its
 * own `openNote(id)`.
 *
 * Why a Set rather than a single handler:
 *   - SingleNoteWindow opens a child window with its own editor. If both
 *     the main shell and the child window happen to be loaded in the
 *     same JS context (popup workflow), each subscribes independently.
 *     The receiver responsible for the focused window handles the open;
 *     the other no-ops because the note isn't in its dockview.
 *   - Survives hot-reload: the old shell unsubscribes on destroy and
 *     the new one re-subscribes on mount without races.
 */

type OpenNoteHandler = (id: string) => void;

const handlers = new Set<OpenNoteHandler>();

/**
 * Register a handler. Returns an unsubscribe function — call it from
 * `onDestroy` to avoid a stale closure outliving the component.
 */
export function subscribeOpenNoteRequest(handler: OpenNoteHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/**
 * Fire all subscribers with the requested note id. Each shell decides
 * for itself whether the note is in its scope (a no-op if not).
 *
 * Returns `true` if at least one handler ran, `false` if nothing was
 * subscribed — useful for debugging "I clicked a wikilink and nothing
 * happened" without inspecting the wrong layer.
 */
export function requestOpenNote(id: string): boolean {
  if (handlers.size === 0) {
    console.warn(
      '[open-note-intent] no subscriber; nothing handled request for',
      id
    );
    return false;
  }
  for (const h of handlers) h(id);
  return true;
}
