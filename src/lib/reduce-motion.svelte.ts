/**
 * Single source of truth for "should the UI animate?".
 *
 * `appearance.reduceMotion` is a tri-state radio: `system` (default)
 * follows the OS-level `prefers-reduced-motion` preference, `on` / `off`
 * override it in both directions. Everything motion-related — the global
 * `html.reduce-motion` class that CSS keys off, and every JS consumer
 * that gates animation programmatically — must resolve through
 * `prefersReducedMotion()` so the answer is the same everywhere.
 *
 * Values written by older builds were booleans (`true` / `false`);
 * `reduceMotionSetting()` coerces them (`true` → `on`, `false` → the
 * old behaviour of still honouring the OS pref, i.e. `system`).
 */

import { getSettingValue } from '$lib/settings/store.svelte';

export type ReduceMotionSetting = 'system' | 'on' | 'off';

const osPrefersReduced = $state({ current: false });

if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  osPrefersReduced.current = query.matches;
  query.addEventListener('change', (event) => {
    osPrefersReduced.current = event.matches;
  });
}

/** Exposed for tests: simulate an OS preference change. */
export function setOsPrefersReducedMotionForTesting(value: boolean): void {
  osPrefersReduced.current = value;
}

/** The stored setting, with legacy boolean values coerced. */
export function reduceMotionSetting(): ReduceMotionSetting {
  const value = getSettingValue('appearance.reduceMotion');
  if (value === true) return 'on';
  if (value === 'on' || value === 'off') return value;
  return 'system';
}

/** Resolved preference: the app setting wins, `system` follows the OS. */
export function prefersReducedMotion(): boolean {
  const setting = reduceMotionSetting();
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return osPrefersReduced.current;
}
