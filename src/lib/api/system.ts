/**
 * Tiny system-introspection bridge. Mirror of src-tauri/src/system.rs.
 *
 * Currently one call: `isAppImageInstall()`. The updater action uses it
 * to skip the in-app update flow on Linux installs the Tauri updater
 * can't apply (rpm / deb), pointing the user to a manual download
 * instead of starting a download that hangs in the install phase.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { isTauri } from './core';

/**
 * True when the running binary was launched as an AppImage (i.e. the
 * `APPIMAGE` env var is set, which AppImage's AppRun wrapper exports).
 *
 * Returns false outside Tauri (browser dev) and on non-Linux platforms;
 * callers shouldn't rely on it as a substitute for `getPlatform() ===
 * 'linux'`. The only meaningful use is "we're on Linux — can the
 * updater plugin actually apply an update here?"
 */
export async function isAppImageInstall(): Promise<boolean> {
  if (!isTauri()) return false;
  return await tauriInvoke<boolean>('is_appimage_install');
}

/**
 * Reboot the app process via the native Android restart bridge (see
 * src-tauri/src/app_restart.rs). Used by the mobile vault switch to
 * reload into the newly-activated vault — desktop relaunches through
 * `@tauri-apps/plugin-process` instead and never calls this.
 *
 * The `restart_app` command only exists on Android, so on any other
 * target (desktop, browser dev) the invoke rejects; callers treat that
 * as "couldn't restart automatically" and fall back to a manual-relaunch
 * notice. A successful call never resolves — the process is killed.
 */
export async function restartApp(): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>('restart_app');
}
