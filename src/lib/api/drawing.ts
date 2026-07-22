/**
 * Ink note bridge — JS side.
 *
 * The canonical ink editor is the Svelte/Pointer Events canvas. Rust
 * persists Yrs/Yjs v1 update bytes via `drawing_save_ink_state`. The
 * live-overlay commands drive Kotlin's `CanvasFrontBufferedRenderer`
 * on Android and are silent no-ops on desktop.
 */

import { assertVoid, TauriCommandName, invokeOrFallback } from './core';
import { mockApi } from './mock-store';

export function drawingShowLiveInkOverlay(): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.DrawingShowLiveInkOverlay,
    undefined,
    () => undefined,
    (value) => assertVoid(value, 'drawing_show_live_ink_overlay response')
  );
}

export function drawingHideLiveInkOverlay(): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.DrawingHideLiveInkOverlay,
    undefined,
    () => undefined,
    (value) => assertVoid(value, 'drawing_hide_live_ink_overlay response')
  );
}

export function drawingEnterImmersiveInkMode(): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.DrawingEnterImmersiveInkMode,
    undefined,
    () => undefined,
    (value) => assertVoid(value, 'drawing_enter_immersive_ink_mode response')
  );
}

export function drawingExitImmersiveInkMode(): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.DrawingExitImmersiveInkMode,
    undefined,
    () => undefined,
    (value) => assertVoid(value, 'drawing_exit_immersive_ink_mode response')
  );
}

export function drawingCancelLiveInk(): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.DrawingCancelLiveInk,
    undefined,
    () => undefined,
    (value) => assertVoid(value, 'drawing_cancel_live_ink response')
  );
}

export function drawingSetLiveInkStyle(
  colorArgb: number,
  minWidthPx: number,
  maxWidthPx: number
): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.DrawingSetLiveInkStyle,
    { colorArgb, minWidthPx, maxWidthPx },
    () => undefined,
    (value) => assertVoid(value, 'drawing_set_live_ink_style response')
  );
}

export function drawingSetLiveInkFingerDrawing(
  allowed: boolean
): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.DrawingSetLiveInkFingerDrawing,
    { allowed },
    () => undefined,
    (value) => assertVoid(value, 'drawing_set_live_ink_finger_drawing response')
  );
}

/**
 * Push the screen-space bounds of the ink document's visible pages to
 * the Android live overlay — the only region it's allowed to paint
 * in. Flat list of [x0, y0, x1, y1] quads in webview-local surface
 * pixels. Pass an empty list to disable painting entirely (trashed
 * note, layout not ready). No-op on desktop.
 */
export function drawingSetDocumentBounds(bounds: number[]): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.DrawingSetDocumentBounds,
    { bounds },
    () => undefined,
    (value) => assertVoid(value, 'drawing_set_document_bounds response')
  );
}

/**
 * Push the screen-space bounds of Svelte UI controls (ink toolbar,
 * popovers, …) to the Android live-ink overlay so it refuses to paint
 * over them. `bounds` is a flat list of [x0, y0, x1, y1] rectangles in
 * webview-local surface pixels — i.e. `getBoundingClientRect()` values
 * multiplied by `devicePixelRatio`. Pass an empty list to clear.
 * No-op on desktop.
 */
export function drawingSetControlBounds(bounds: number[]): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.DrawingSetControlBounds,
    { bounds },
    () => undefined,
    (value) => assertVoid(value, 'drawing_set_control_bounds response')
  );
}

/**
 * Persist an ink note state update through the same Rust merge/write
 * helper sync uses. The payload is a Yrs/Yjs v1 update produced by the
 * Svelte canvas editor (`$lib/ink/document`).
 */
export function drawingSaveInkState(
  noteId: string,
  yrsState: number[]
): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.DrawingSaveInkState,
    { noteId, yrsState },
    async () => {
      await mockApi.saveNote({ id: noteId, yrs_state: yrsState });
    },
    (value) => assertVoid(value, 'drawing_save_ink_state response')
  );
}

export interface DrawingToolbarSettingsPayload {
  tool: 'pen' | 'eraser' | 'lasso';
  colorArgb: number;
  width: number;
  fingerDrawingAllowed: boolean;
  pageThemeMode: 'light' | 'dark' | 'system';
  pageBackground: 'clear' | 'points' | 'lines' | 'grid';
}

export interface DrawingToolbarSettings {
  tool?: 'pen' | 'eraser' | 'lasso' | null;
  colorArgb?: number | null;
  width?: number | null;
  fingerDrawingAllowed?: boolean | null;
  pageThemeMode?: 'light' | 'dark' | 'system' | null;
  pageBackground?: 'clear' | 'points' | 'lines' | 'grid' | null;
}
