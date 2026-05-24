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
 * Bring the native drawing surface up for the given note. Combines
 * "show the SurfaceView" + "activate this note's stroke document"
 * in one command on purpose — splitting them opens a race where
 * the surface would briefly render the previous note's strokes
 * before the active-note swap landed.
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
