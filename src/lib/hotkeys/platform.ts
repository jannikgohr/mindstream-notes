/**
 * Tiny isolated helper so the rest of the hotkey module never reads
 * `navigator.platform` directly. Kept separate (instead of folded into
 * `$lib/platform.ts`) because:
 *
 *   - the existing helper resolves a *user-facing* platform (`windows` /
 *     `linux` / `macos`), and the matcher only needs the "is the mod key
 *     Cmd or Ctrl?" question;
 *   - it's pure, synchronous, and safe to call during SSR (returns
 *     `false` when `navigator` is undefined) — `isMobile()`'s SSR
 *     handling is the same model.
 *
 * The check uses `navigator.platform` (with `userAgent` as a fallback)
 * rather than `userAgentData.platform` because `userAgentData` is
 * Chromium-only — Safari and Firefox would both return `false` from a
 * UAD check and silently flip every Mac shortcut to Ctrl.
 */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const p = (navigator as { platform?: string }).platform ?? '';
  if (p) return /mac|iphone|ipad|ipod/i.test(p);
  return /mac|iphone|ipad|ipod/i.test(navigator.userAgent);
}
