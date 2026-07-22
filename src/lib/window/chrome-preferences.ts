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

export function customWindowDecorationsFromEventPayload(
  payload: unknown
): boolean {
  return payload === true;
}
