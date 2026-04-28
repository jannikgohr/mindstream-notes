/**
 * Persistent UI preferences.
 *
 * Currently backed by localStorage (works in both `pnpm dev` and `pnpm tauri
 * dev`). When you wire up real persistence in Rust, swap this implementation
 * for one that calls `invoke('load_preferences' | 'save_preferences', ...)`
 * — the rest of the app talks to `loadPreferences`/`savePreferences` only,
 * so the call sites won't change.
 */

import type { SortStrategy } from './sort';

const STORAGE_KEY = 'notes-app:preferences:v1';

export interface Preferences {
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  sortStrategy: SortStrategy;
}

export const DEFAULT_PREFERENCES: Preferences = {
  leftSidebarWidth: 240,
  rightSidebarWidth: 260,
  leftSidebarOpen: true,
  rightSidebarOpen: true,
  sortStrategy: 'alphabetical'
};

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

const VALID_SORTS = new Set<SortStrategy>([
  'alphabetical',
  'modified',
  'created'
]);

export function loadPreferences(): Preferences {
  if (!isBrowser()) return { ...DEFAULT_PREFERENCES };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      ...DEFAULT_PREFERENCES,
      ...parsed,
      leftSidebarWidth: clamp(
        parsed.leftSidebarWidth ?? DEFAULT_PREFERENCES.leftSidebarWidth,
        160,
        600
      ),
      rightSidebarWidth: clamp(
        parsed.rightSidebarWidth ?? DEFAULT_PREFERENCES.rightSidebarWidth,
        180,
        600
      ),
      sortStrategy:
        parsed.sortStrategy && VALID_SORTS.has(parsed.sortStrategy)
          ? parsed.sortStrategy
          : DEFAULT_PREFERENCES.sortStrategy
    };
  } catch (err) {
    console.warn('[preferences] load failed, using defaults', err);
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(prefs: Preferences): void {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch (err) {
    console.warn('[preferences] save failed', err);
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
