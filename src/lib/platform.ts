/**
 * Platform detection for branching mobile-only vs desktop-only UI.
 *
 * Decisions read navigator.userAgent so the same check works inside the
 * Tauri Android webview and a plain `pnpm dev` browser tab. Tauri does
 * not currently expose a synchronous platform-name accessor on the JS
 * side, and adding @tauri-apps/plugin-os just for a boolean is heavier
 * than this check needs to be.
 *
 * All helpers are safe to call during SSR / prerender — they return
 * false when `navigator` is undefined. Treat them as client-only signals
 * and gate any UI decisions behind onMount / $effect so the server-
 * rendered HTML doesn't lock in the desktop or mobile branch.
 */

const MOBILE_UA = /android|iphone|ipad|ipod/i;
const ANDROID_UA = /android/i;

export function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  return MOBILE_UA.test(navigator.userAgent);
}

export function isAndroid(): boolean {
  if (typeof navigator === 'undefined') return false;
  return ANDROID_UA.test(navigator.userAgent);
}
