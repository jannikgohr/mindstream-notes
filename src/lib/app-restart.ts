/**
 * Restart the app so a staged change takes effect on the next boot.
 *
 * Each platform restarts differently: desktop relaunches through
 * `@tauri-apps/plugin-process`, which only desktop registers, and Android
 * goes through the native `restart_app` bridge (src-tauri/src/app_restart.rs).
 * iOS and the browser have neither.
 */

import { isTauri, restartApp } from '$lib/api';
import { isAndroid, isMobile } from '$lib/platform';

/**
 * Resolves `false` when the app could not restart itself, so the caller can
 * ask the user to reopen it. A successful restart ends the process and never
 * resolves.
 */
export async function restartToApply(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    if (isAndroid()) {
      await restartApp();
    } else if (isMobile()) {
      return false;
    } else {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    }
    return true;
  } catch (err) {
    console.error('[restart] automatic restart failed', err);
    return false;
  }
}
