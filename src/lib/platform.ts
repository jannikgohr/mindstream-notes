/**
 * Platform detection for branching mobile-only vs desktop-only UI and
 * for filtering schema entries by `platforms: [...]`.
 *
 * Decisions read navigator.userAgent so the same check works inside the
 * Tauri Android webview and a plain `pnpm dev` browser tab. Tauri does
 * not currently expose a synchronous platform-name accessor on the JS
 * side, and adding @tauri-apps/plugin-os just for a boolean is heavier
 * than this check needs to be.
 *
 * All helpers are safe to call during SSR / prerender — they return
 * conservative defaults when `navigator` is undefined. Treat them as
 * client-only signals and gate any UI decisions behind onMount /
 * $effect so the server-rendered HTML doesn't lock in the desktop or
 * mobile branch.
 */

const MOBILE_UA = /android|iphone|ipad|ipod/i;
const ANDROID_UA = /android/i;

/** Specific operating systems. The schema can target these directly. */
export type Platform =
  | 'windows'
  | 'macos'
  | 'linux'
  | 'freebsd'
  | 'android'
  | 'ios';

/** Coarse groupings — the common case for schema filters. */
export type PlatformGroup = 'desktop' | 'mobile';

/** What you can put in a `platforms: [...]` array in the settings schema. */
export type PlatformFilter = Platform | PlatformGroup;

const DESKTOP_PLATFORMS: Platform[] = ['windows', 'macos', 'linux', 'freebsd'];
const MOBILE_PLATFORMS: Platform[] = ['android', 'ios'];

export function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  return MOBILE_UA.test(navigator.userAgent);
}

export function isAndroid(): boolean {
  if (typeof navigator === 'undefined') return false;
  return ANDROID_UA.test(navigator.userAgent);
}

/**
 * Resolve the current platform from `navigator.userAgent`. Order matters:
 * mobile UAs frequently carry the parent desktop string (e.g. Android
 * webviews include "Linux"), so check the mobile patterns first.
 *
 * Returns `null` outside the browser (SSR/prerender) and for UAs we
 * don't recognise; consumers treat that as "show everything" so an
 * unknown environment doesn't accidentally hide a setting.
 */
export function getPlatform(): Platform | null {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/windows/i.test(ua)) return 'windows';
  // Order: macOS UAs say "Mac OS X" / "Macintosh"; Linux is anything
  // else with "linux" in it that didn't already match android.
  if (/mac os x|macintosh/i.test(ua)) return 'macos';
  if (/freebsd/i.test(ua)) return 'freebsd';
  if (/linux/i.test(ua)) return 'linux';
  return null;
}

/**
 * True when the current platform falls inside the provided filter.
 *
 * Falsy / empty `filter` ⇒ always true (no platform constraint). An
 * unknown current platform (`getPlatform() === null`) also returns true
 * so the dialog never silently disappears on a UA we forgot to parse.
 *
 * The filter can mix specific OS names (`'android'`, `'windows'`, …)
 * and coarse groups (`'mobile'`, `'desktop'`). Both are accepted in the
 * same array: e.g. `['windows', 'mobile']` matches Windows + Android +
 * iOS but not macOS or Linux.
 */
export function matchesPlatformFilter(
  filter: readonly PlatformFilter[] | undefined | null
): boolean {
  if (!filter || filter.length === 0) return true;
  const current = getPlatform();
  if (current === null) return true;
  for (const entry of filter) {
    if (entry === current) return true;
    if (entry === 'desktop' && DESKTOP_PLATFORMS.includes(current)) return true;
    if (entry === 'mobile' && MOBILE_PLATFORMS.includes(current)) return true;
  }
  return false;
}
