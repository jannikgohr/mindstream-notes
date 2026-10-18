import { isTauri } from '$lib/api/core';
import {
  getGlobalShortcutStatus,
  type GlobalShortcutStatus
} from '$lib/api/hotkeys';
import { isMobile } from '$lib/platform';
import { globalShortcutAccelerator } from './format';

export const globalShortcutOwnership = $state<{
  status: GlobalShortcutStatus | null;
  error: string | null;
}>({ status: null, error: null });

async function refresh(): Promise<GlobalShortcutStatus | null> {
  try {
    const status = await getGlobalShortcutStatus();
    globalShortcutOwnership.status = status;
    globalShortcutOwnership.error = status.error;
    return status;
  } catch (error) {
    globalShortcutOwnership.error =
      error instanceof Error ? error.message : String(error);
    return null;
  }
}

export function watchGlobalShortcutOwnership(): () => void {
  if (!isTauri() || isMobile()) return () => {};
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
    await refresh();
    if (!stopped) timer = setTimeout(() => void poll(), 1000);
  };
  void poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** Query native ownership before dispatch. A lost coordinator reply cannot
 * authorize a second note in a different vault. */
export function nativeOwnsGlobalShortcut(
  commandId: string,
  binding: string | null
): Promise<boolean> | null {
  if (!isTauri() || isMobile()) return null;
  const accelerator = globalShortcutAccelerator(binding);
  if (!accelerator) return null;
  return refresh().then(
    (status) =>
      !status ||
      (status.coordinated &&
        (status.settling ||
          status.registered.some(
            (entry) =>
              entry.commandId === commandId && entry.accelerator === accelerator
          )))
  );
}
