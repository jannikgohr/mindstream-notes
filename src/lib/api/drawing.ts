/**
 * Native drawing surface — JS bridge.
 *
 * The Rust side (`src-tauri/src/drawing/mod.rs`) exposes three commands
 * that toggle / clear the Android SurfaceView injected behind the
 * WebView. All three are no-ops on desktop and outside Tauri, so we
 * route through `invokeOrFallback` and never throw — the
 * DrawingNoteEditor renders a desktop-only placeholder anyway.
 */

import { invokeOrFallback } from './index';

/**
 * Bring the native drawing surface up for the given note and seed
 * its in-memory stroke document with the persisted CRDT bytes.
 *
 * The Rust side reads `yrs_state` from SQLite itself rather than
 * accepting the bytes as an IPC arg — bypassing Tauri's JSON-encoded
 * IPC (which adds ~700ms per MB measured on real device traffic with
 * the StrokesDoc shape). Frontend callers just hand over the note
 * id; a fresh / never-saved note is treated as an empty StrokesDoc
 * inside Rust.
 *
 * "Show the SurfaceView" and "activate this note's stroke document"
 * are combined in one command on purpose — splitting them would
 * open a race where the surface briefly renders the previous note's
 * strokes before the active-note swap landed.
 */
export function drawingShow(noteId: string): Promise<void> {
  return invokeOrFallback<void>('drawing_show', { noteId }, () => undefined);
}

export function drawingHide(): Promise<void> {
  return invokeOrFallback<void>('drawing_hide', undefined, () => undefined);
}

export function drawingClear(): Promise<void> {
  return invokeOrFallback<void>('drawing_clear', undefined, () => undefined);
}

/**
 * Push a new auto-save debounce window (in ms) to the Rust-side
 * save worker. Used by `DrawingNoteEditor.svelte` to keep the
 * worker's debounce in sync with the user's setting.
 *
 * Pre-P4 the debounce was a `setTimeout` inside the Svelte editor,
 * which round-tripped the yrs blob through Tauri's JSON-encoded IPC
 * twice (drawingGetState + saveNote). Now the worker owns both the
 * debounce and the SQLite write; JS only sends the ms value.
 *
 * Idempotent on the Rust side — same-value re-pushes are no-ops.
 */
export function drawingSetSaveDebounce(ms: number): Promise<void> {
  return invokeOrFallback<void>(
    'drawing_set_save_debounce',
    { ms },
    () => undefined
  );
}

/**
 * Per-note save-status event the Rust save worker emits whenever
 * an ink note transitions between editing / saving / saved / error.
 * `DrawingNoteEditor.svelte` listens, filters by note id, and
 * mirrors `status` into the global note-status store so the
 * dockview saving-icon reflects live state.
 *
 * Event name + payload shape must stay in sync with
 * `src-tauri/src/drawing/save_worker.rs::SAVE_STATUS_EVENT` and
 * `SaveStatusEvent`.
 */
export const DRAWING_SAVE_STATUS_EVENT = 'drawing:save_status';

export interface DrawingSaveStatusPayload {
  note_id: string;
  /** Snake-cased server-side serde — matches Rust's `SaveStatus`. */
  status: 'editing' | 'saving' | 'saved' | 'error';
}
