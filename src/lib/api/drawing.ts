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
 * its in-memory stroke document with the persisted CRDT bytes from
 * SQLite. Combines "show the SurfaceView" + "activate this note's
 * stroke document" in one command on purpose — splitting them opens
 * a race where the surface would briefly render the previous note's
 * strokes before the active-note swap landed.
 *
 * `yrsState` is the `note.yrs_state` field from `loadNote(noteId)`.
 * Pass `[]` for a brand-new note that's never been saved.
 */
export function drawingShow(noteId: string, yrsState: number[]): Promise<void> {
  return invokeOrFallback<void>(
    'drawing_show',
    { noteId, yrsState },
    () => undefined
  );
}

export function drawingHide(): Promise<void> {
  return invokeOrFallback<void>('drawing_hide', undefined, () => undefined);
}

export function drawingClear(): Promise<void> {
  return invokeOrFallback<void>('drawing_clear', undefined, () => undefined);
}

/**
 * Fetch the active ink note's stroke document as CRDT bytes — the
 * shape that goes into `saveNote(..., yrs_state=...)` for SQLite
 * persistence and Etebase sync. Returns `[]` if there's no active
 * note (e.g. called from outside Tauri or before drawingShow).
 *
 * On the Rust side this is a synchronous round-trip to the render
 * thread bounded by a 500ms timeout, so the Promise typically
 * resolves within a few ms.
 */
export function drawingGetState(): Promise<number[]> {
  return invokeOrFallback<number[]>('drawing_get_state', undefined, () => []);
}
