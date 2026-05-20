/**
 * Per-note "what's happening with this editor right now" status —
 * collab connection, saving state, trashed flag. Editors mirror their
 * own reactive state into this store; the dockview right-header reads
 * the entry keyed by `ui.activeNoteId` and renders icon-only chips
 * next to the popout button.
 *
 * Why a global store and not editor-local state: dockview's right-
 * header renderer is one instance per tab GROUP (not per panel), and
 * the icons need to reflect whichever panel is currently active in
 * that group. Threading per-panel state through `IGroupHeaderProps`
 * would require live subscription plumbing on each panel-activation
 * event. A keyed store is the same plumbing every other
 * "active-panel-cares-about-this" widget in the app already uses (see
 * MetadataPanel).
 *
 * Entries are written by each editor's onMount/effect and cleared in
 * onDestroy so closing a panel removes its row.
 */

export type SavingState =
  | 'idle'
  | 'pending'
  | 'saving'
  | 'saved'
  | 'error';

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
}

const EMPTY: NoteStatus = {
  collabConfigured: false,
  collabOnline: false,
  savingState: 'idle',
  isTrashed: false
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
