import { pushToast } from '$lib/components/toast.svelte';
import { tUi } from '$lib/settings/i18n.svelte';

export const nativeDeviceUi = $state<{
  initialized: boolean;
  revision: number;
  toolbar: unknown;
  mobileToolbar: unknown;
  displayMode: 'list' | 'grid';
}>({
  initialized: false,
  revision: 0,
  toolbar: null,
  mobileToolbar: null,
  displayMode: 'list'
});

let writer: ((id: string, value: unknown) => Promise<void>) | null = null;

export function registerNativeDeviceUiWriter(
  value: (id: string, value: unknown) => Promise<void>
): void {
  writer = value;
}

export function applyNativeDeviceUi(values: Record<string, unknown>): void {
  nativeDeviceUi.toolbar = values['ui.fileTreeToolbar'] ?? null;
  nativeDeviceUi.mobileToolbar = values['ui.mobileCreateToolbar'] ?? null;
  nativeDeviceUi.displayMode =
    values['ui.mobileDisplayMode'] === 'grid' ? 'grid' : 'list';
  nativeDeviceUi.initialized = true;
  nativeDeviceUi.revision += 1;
}

export function writeNativeDeviceUi(id: string, value: unknown): Promise<void> {
  const task =
    writer && nativeDeviceUi.initialized
      ? writer(id, value)
      : Promise.reject(new Error('device UI preferences have not initialized'));
  void task.catch((err) => {
    console.warn('[device-ui] save failed', err);
    pushToast(tUi('preferences.saveFailed'), { variant: 'error' });
  });
  return task;
}
