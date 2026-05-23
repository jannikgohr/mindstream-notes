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

export function drawingShow(): Promise<void> {
  return invokeOrFallback<void>('drawing_show', undefined, () => undefined);
}

export function drawingHide(): Promise<void> {
  return invokeOrFallback<void>('drawing_hide', undefined, () => undefined);
}

export function drawingClear(): Promise<void> {
  return invokeOrFallback<void>('drawing_clear', undefined, () => undefined);
}
