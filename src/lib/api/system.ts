/**
 * Tiny system-introspection bridge. Mirror of src-tauri/src/system.rs.
 *
 * Currently one call: `isAppImageInstall()`. The updater action uses it
 * to skip the in-app update flow on Linux installs the Tauri updater
 * can't apply (rpm / deb), pointing the user to a manual download
 * instead of starting a download that hangs in the install phase.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { isTauri } from './index';

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
