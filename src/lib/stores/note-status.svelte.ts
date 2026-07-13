/**
 * Per-note "what's happening with this editor right now" status —
 * collab connection, saving state, trashed flag. Editors mirror their
 * own reactive state into this store; chrome surfaces read entries by
 * note id and render icon-only chips next to the popout button /
 * mobile title.
 *
 * Why a global store and not editor-local state: dockview's right-
 * header renderer is one instance per tab GROUP (not per panel), and
 * the icons need to reflect whichever panel is currently active in
 * that group. A keyed store lets the group header hand over just a
 * note id while each editor continues owning its own status lifecycle.
 *
 * Entries are written by each editor's onMount/effect and cleared in
 * onDestroy so closing a panel removes its row.
 */

export type SavingState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface NoteStatus {
  /** Live-collab relay is configured for this note (URL set, room
   *  fetched). When false, the connect/disconnect icon is hidden. */
  collabConfigured: boolean;
  /** WebSocket is currently connected. Only meaningful when
   *  `collabConfigured` is true. */
  collabOnline: boolean;
  /** Save debounce state, drives the editing/saving/saved/error
   *  icon. Trashed notes always render as read-only regardless. */
  savingState: SavingState;
  /** Note is in the trash (directly or via a trashed ancestor). The
   *  icon stack collapses to a single read-only chip. */
  isTrashed: boolean;
  /** Note lives in a folder shared *with* the user at read-only access.
   *  The editor is locked (like trash) but the affordance is a view-only
   *  chip, not a trash chip. */
  readOnly: boolean;
}

const EMPTY: NoteStatus = {
  collabConfigured: false,
  collabOnline: false,
  savingState: 'idle',
  isTrashed: false,
  readOnly: false
};

export const noteStatus = $state<Record<string, NoteStatus>>({});

export function setNoteStatus(noteId: string, status: NoteStatus) {
  noteStatus[noteId] = status;
}

export function clearNoteStatus(noteId: string) {
  delete noteStatus[noteId];
}

/** Read the status for a note id, returning a constant empty
 *  placeholder when the id is null/unknown so consumers can render
 *  without null-checks. The returned object is the live $state
 *  reference (or the constant placeholder), so reading fields off it
 *  in a $derived correctly tracks per-field reactivity. */
export function getNoteStatus(noteId: string | null | undefined): NoteStatus {
  if (!noteId) return EMPTY;
  return noteStatus[noteId] ?? EMPTY;
}
