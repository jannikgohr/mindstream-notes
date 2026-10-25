import type { Platform } from '$lib/platform';
import { TauriEventName } from '$lib/api/events';

export const CUSTOM_WINDOW_DECORATIONS_CHANGED_EVENT =
  TauriEventName.CustomWindowDecorationsChanged;
export const CUSTOM_WINDOW_DECORATIONS_SETTING_ID =
  'appearance.customWindowDecorations';

export function defaultCustomWindowDecorations(
  platform: Platform | null
): boolean {
  return platform !== 'macos';
}

/**
 * Whether a URL query asks for the window controls preview: `?windowControls`
 * draws the minimize, maximize and close buttons in a plain browser, where
 * there is no window to control, so screenshots of the browser build look
 * like the desktop app.
 */
export function windowControlsPreviewRequested(search: string): boolean {
  return new URLSearchParams(search).has('windowControls');
}

export function customWindowDecorationsFromEventPayload(
  payload: unknown
): boolean {
  return payload === true;
}
