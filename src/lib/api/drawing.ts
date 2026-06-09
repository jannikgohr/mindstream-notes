/**
 * Ink note bridge — JS side.
 *
 * The canonical ink editor is the Svelte/Pointer Events canvas. Rust
 * persists Yrs/Yjs v1 update bytes via `drawing_save_ink_state`. The
 * live-overlay commands drive Kotlin's `CanvasFrontBufferedRenderer`
 * on Android and are silent no-ops on desktop.
 */

import { invokeOrFallback } from './index';
import { mockApi } from './mock-store';

export function drawingShowLiveInkOverlay(): Promise<void> {
  return invokeOrFallback<void>(
    'drawing_show_live_ink_overlay',
    undefined,
    () => undefined
  );
}

export function drawingHideLiveInkOverlay(): Promise<void> {
  return invokeOrFallback<void>(
    'drawing_hide_live_ink_overlay',
    undefined,
    () => undefined
  );
}

export function drawingEnterImmersiveInkMode(): Promise<void> {
  return invokeOrFallback<void>(
    'drawing_enter_immersive_ink_mode',
    undefined,
    () => undefined
  );
}

export function drawingExitImmersiveInkMode(): Promise<void> {
  return invokeOrFallback<void>(
    'drawing_exit_immersive_ink_mode',
    undefined,
    () => undefined
  );
}

export function drawingCancelLiveInk(): Promise<void> {
  return invokeOrFallback<void>(
    'drawing_cancel_live_ink',
    undefined,
    () => undefined
  );
}

export function drawingSetLiveInkStyle(
  colorArgb: number,
  minWidthPx: number,
  maxWidthPx: number
): Promise<void> {
  return invokeOrFallback<void>(
    'drawing_set_live_ink_style',
    { colorArgb, minWidthPx, maxWidthPx },
    () => undefined
  );
}

export function drawingSetLiveInkFingerDrawing(
  allowed: boolean
): Promise<void> {
  return invokeOrFallback<void>(
    'drawing_set_live_ink_finger_drawing',
    { allowed },
    () => undefined
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
    'drawing_save_ink_state',
    { noteId, yrsState },
    async () => {
      await mockApi.saveNote({ id: noteId, yrs_state: yrsState });
    }
  );
}

export interface DrawingToolbarSettingsPayload {
  tool: 'pen' | 'eraser';
  colorArgb: number;
  width: number;
  fingerDrawingAllowed: boolean;
  pageThemeMode: 'light' | 'system';
}

export interface DrawingToolbarSettings {
  tool?: 'pen' | 'eraser' | null;
  colorArgb?: number | null;
  width?: number | null;
  fingerDrawingAllowed?: boolean | null;
  pageThemeMode?: 'light' | 'system' | null;
}
