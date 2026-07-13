/**
 * Bridge between an open note editor and the History sidebar section.
 *
 * The sidebar acts on `ui.activeNoteId` but the live editor (which owns the
 * Yjs doc / collab service) is a separate component it can't reach by props.
 * The existing focus-based editor bus (`registerEditor` / `EditorListener`)
 * only routes parameter-less command ids, but a restore needs to *hand the
 * editor the target snapshot* and *read the editor's current snapshot* for the
 * diff/undo checkpoint. So this is a tiny per-note registry of those callbacks.
 *
 * `registeredNotes` is reactive so the sidebar can enable/disable Restore as
 * editors mount and unmount (a note must be open to apply a restore as ops).
 */

import { SvelteMap, SvelteSet } from 'svelte/reactivity';

export interface NoteHistoryApi {
  /** Apply a snapshot to the live doc as normal editable state (a restore). */
  restoreSnapshot: (snapshot: string) => void | Promise<void>;
  /** The editor's current snapshot, for diffing and undoable restore capture. */
  currentSnapshot: () => string | Promise<string>;
  /**
   * Ask the editor to capture pending history work now (deduped) and reset the
   * idle-capture timer. Binary editors may capture the latest saved state so
   * refresh never forces a large live Yjs encode on the UI thread.
   */
  snapshotNow: () => Promise<void>;
  /**
   * Number of other collaborators currently editing this note live, used to
   * warn before a restore overwrites shared content. Optional: editors without
   * live presence (ink, freeform) omit it, and a restore there proceeds without
   * a collab prompt. Returns 0 when synced but alone.
   */
  peerCount?: () => number;
  /** E2E-only: disconnect/reconnect the live collab provider for this editor. */
  setCollabPaused?: (paused: boolean) => void | Promise<void>;
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

/** The payload needed to undo a just-applied restore: re-apply this body. */
export interface RestoreUndo {
  /** Pre-restore snapshot — markdown text or a base64 Yjs envelope. */
  body: string;
  /** The checkpoint version this body was captured as, if one was created. */
  checkpointId: string | null;
}

/**
 * Pending "undo the restore" affordance, keyed by note. Lives here rather than
 * in the History panel's component state so it survives the panel remounting —
 * a tree/sync refresh rebuilds `notesById` a few seconds after a restore's
 * save, which would otherwise wipe a component-local banner mid-view. There's
 * no timer: it persists until the user undoes it, closes it, starts another
 * restore, or the app reloads. Reactive.
 */
const restoreUndos = new SvelteMap<string, RestoreUndo>();

/** Reactive read of a note's pending restore-undo, or null if none. */
export function noteRestoreUndo(noteId: string): RestoreUndo | null {
  return restoreUndos.get(noteId) ?? null;
}

/** Arm the restore-undo affordance for `noteId`. */
export function setRestoreUndo(noteId: string, undo: RestoreUndo): void {
  restoreUndos.set(noteId, undo);
}

/** Clear a note's pending restore-undo (undone, dismissed, or consumed). */
export function clearRestoreUndo(noteId: string): void {
  restoreUndos.delete(noteId);
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

declare global {
  interface Window {
    __mindstreamE2E?: {
      notePeerCount(noteId: string): number;
      setNoteCollabPaused(noteId: string, paused: boolean): Promise<void>;
    };
  }
}

if (
  typeof window !== 'undefined' &&
  import.meta.env.VITE_MINDSTREAM_E2E === '1'
) {
  window.__mindstreamE2E = {
    notePeerCount(noteId: string): number {
      return getNoteHistory(noteId)?.peerCount?.() ?? 0;
    },
    async setNoteCollabPaused(noteId: string, paused: boolean): Promise<void> {
      const setPaused = getNoteHistory(noteId)?.setCollabPaused;
      if (!setPaused)
        throw new Error(`note ${noteId} has no collab pause hook`);
      await setPaused(paused);
    }
  };
}
