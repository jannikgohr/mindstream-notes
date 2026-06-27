/**
 * Bridge between an open note editor and the History sidebar section.
 *
 * The sidebar acts on `ui.activeNoteId` but the live editor (which owns the
 * Yjs doc / collab service) is a separate component it can't reach by props.
 * The existing focus-based editor bus (`registerEditor` / `EditorListener`)
 * only routes parameter-less command ids, but a restore needs to *hand the
 * editor the target markdown* and *read the editor's current markdown* for the
 * diff. So this is a tiny per-note registry of those two callbacks.
 *
 * `registeredNotes` is reactive so the sidebar can enable/disable Restore as
 * editors mount and unmount (a note must be open to apply a restore as ops).
 */

import { SvelteMap, SvelteSet } from 'svelte/reactivity';

export interface NoteHistoryApi {
  /** Apply `markdown` to the live doc as collaborative edits (a restore). */
  revert: (markdown: string) => void;
  /** The editor's current markdown, for diffing against a version. */
  currentMarkdown: () => string;
  /**
   * Capture a version of the current editor state right now (deduped) and reset
   * the idle-capture timer. Used by the History panel's refresh button so an
   * explicit refresh also snapshots what the user is looking at.
   */
  snapshotNow: () => Promise<void>;
}

const registry = new Map<string, NoteHistoryApi>();

/** Note ids with a live editor bridge — reactive for the sidebar. */
export const registeredNotes = new SvelteSet<string>();

/**
 * Per-note capture counter. The editor bumps it after persisting a version so
 * an open History panel re-lists live (the capture happens in the editor, the
 * list in the sidebar — without this they're disconnected). Reactive.
 */
const epochs = new SvelteMap<string, number>();

/** Reactive read of a note's capture epoch — depend on this to auto-refresh. */
export function noteHistoryEpoch(noteId: string): number {
  return epochs.get(noteId) ?? 0;
}

/** Signal that a version was just captured for `noteId`. */
export function bumpNoteHistory(noteId: string): void {
  epochs.set(noteId, (epochs.get(noteId) ?? 0) + 1);
}

/** Register the open editor for `noteId`. Returns an unsubscribe for onDestroy. */
export function registerNoteHistory(
  noteId: string,
  api: NoteHistoryApi
): () => void {
  registry.set(noteId, api);
  registeredNotes.add(noteId);
  return () => {
    // Only clear if we're still the registered instance (guards against a
    // remount having already replaced us).
    if (registry.get(noteId) === api) {
      registry.delete(noteId);
      registeredNotes.delete(noteId);
    }
  };
}

export function getNoteHistory(noteId: string): NoteHistoryApi | null {
  return registry.get(noteId) ?? null;
}
