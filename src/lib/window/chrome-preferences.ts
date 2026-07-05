import type { Platform } from '$lib/platform';

export const CUSTOM_WINDOW_DECORATIONS_CHANGED_EVENT =
  'custom-window-decorations-changed';
export const CUSTOM_WINDOW_DECORATIONS_SETTING_ID =
  'appearance.customWindowDecorations';

export function defaultCustomWindowDecorations(
  platform: Platform | null
): boolean {
  return platform !== 'macos';
}

export function customWindowDecorationsFromEventPayload(
  payload: unknown
): boolean {
  return payload === true;
}
