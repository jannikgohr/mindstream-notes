import { getCustomWindowDecorations } from '$lib/api/desktop-settings';
import { isTauri } from '$lib/api/core';
import { getPlatform } from '$lib/platform';
import { settings } from '$lib/settings/store.svelte';

const CUSTOM_WINDOW_DECORATIONS_CHANGED_EVENT =
  'custom-window-decorations-changed';
const SETTING_ID = 'appearance.customWindowDecorations';

export const windowChrome = $state({
  customDecorations: getPlatform() !== 'macos'
});

let initialized = false;

export function initWindowChrome(): void {
  if (initialized) return;
  initialized = true;

  if (!isTauri()) {
    windowChrome.customDecorations = getPlatform() !== 'macos';
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
        setCustomDecorations(event.payload === true);
      })
    )
    .catch((err) => {
      console.warn('[window-chrome] decoration listener unavailable', err);
    });
}

function setCustomDecorations(value: boolean): void {
  windowChrome.customDecorations = value;
  settings.values[SETTING_ID] = value;
}
