import { getCustomWindowDecorations } from '$lib/api/desktop-settings';
import { isTauri } from '$lib/api/core';
import { getPlatform } from '$lib/platform';
import { settings } from '$lib/settings/store.svelte';
import {
  CUSTOM_WINDOW_DECORATIONS_CHANGED_EVENT,
  CUSTOM_WINDOW_DECORATIONS_SETTING_ID,
  customWindowDecorationsFromEventPayload,
  defaultCustomWindowDecorations,
  windowControlsPreviewRequested
} from './chrome-preferences';

export const windowChrome = $state({
  customDecorations: defaultCustomWindowDecorations(getPlatform())
});

let initialized = false;

/**
 * True when the dev server was opened with `?windowControls` in a plain
 * browser. Tauri windows and production builds ignore the query.
 */
export function windowControlsPreview(): boolean {
  return (
    import.meta.env.DEV &&
    typeof window !== 'undefined' &&
    !isTauri() &&
    windowControlsPreviewRequested(window.location.search)
  );
}

export function initWindowChrome(): void {
  if (initialized) return;
  initialized = true;

  if (!isTauri()) {
    windowChrome.customDecorations =
      windowControlsPreview() || defaultCustomWindowDecorations(getPlatform());
    return;
  }

  void getCustomWindowDecorations()
    .then((value) => {
      setCustomDecorations(value);
    })
    .catch((err) => {
      console.warn('[window-chrome] hydrate failed', err);
    });

  void import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen<boolean>(CUSTOM_WINDOW_DECORATIONS_CHANGED_EVENT, (event) => {
        setCustomDecorations(
          customWindowDecorationsFromEventPayload(event.payload)
        );
      })
    )
    .catch((err) => {
      console.warn('[window-chrome] decoration listener unavailable', err);
    });
}

function setCustomDecorations(value: boolean): void {
  windowChrome.customDecorations = value;
  settings.values[CUSTOM_WINDOW_DECORATIONS_SETTING_ID] = value;
}
