/**
 * Persistent UI preferences.
 *
 * Currently backed by localStorage (works in both `pnpm dev` and `pnpm tauri
 * dev`). When you wire up real persistence in Rust, swap this implementation
 * for one that calls `invoke('load_preferences' | 'save_preferences', ...)`
 * — the rest of the app talks to `loadPreferences`/`savePreferences` only,
 * so the call sites won't change.
 */

import type { SortDirection, SortStrategy } from './sort';

const STORAGE_KEY = 'notes-app:preferences:v1';

export interface Preferences {
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  sortStrategy: SortStrategy;
  sortDirection: SortDirection;
}

export const DEFAULT_PREFERENCES: Preferences = {
  leftSidebarWidth: 240,
  rightSidebarWidth: 260,
  leftSidebarOpen: true,
  rightSidebarOpen: true,
  sortStrategy: 'alphabetical',
  // 'asc' matches the natural reading order for alphabetical (the
  // default strategy). Users who switch to recently-modified can flip
  // the direction with one tap on the split sort button.
  sortDirection: 'asc'
};

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

const VALID_SORTS = new Set<SortStrategy>([
  'alphabetical',
  'modified',
  'created'
]);

const VALID_DIRECTIONS = new Set<SortDirection>(['asc', 'desc']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function optionalWidth(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, min, max)
    : fallback;
}

function optionalSortStrategy(value: unknown): SortStrategy {
  return typeof value === 'string' && VALID_SORTS.has(value as SortStrategy)
    ? (value as SortStrategy)
    : DEFAULT_PREFERENCES.sortStrategy;
}

function optionalSortDirection(value: unknown): SortDirection {
  return typeof value === 'string' &&
    VALID_DIRECTIONS.has(value as SortDirection)
    ? (value as SortDirection)
    : DEFAULT_PREFERENCES.sortDirection;
}

export function loadPreferences(): Preferences {
  if (!isBrowser()) return { ...DEFAULT_PREFERENCES };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return { ...DEFAULT_PREFERENCES };
    return {
      leftSidebarWidth: optionalWidth(
        parsed.leftSidebarWidth,
        DEFAULT_PREFERENCES.leftSidebarWidth,
        160,
        600
      ),
      rightSidebarWidth: optionalWidth(
        parsed.rightSidebarWidth,
        DEFAULT_PREFERENCES.rightSidebarWidth,
        180,
        600
      ),
      leftSidebarOpen: optionalBoolean(
        parsed.leftSidebarOpen,
        DEFAULT_PREFERENCES.leftSidebarOpen
      ),
      rightSidebarOpen: optionalBoolean(
        parsed.rightSidebarOpen,
        DEFAULT_PREFERENCES.rightSidebarOpen
      ),
      sortStrategy: optionalSortStrategy(parsed.sortStrategy),
      sortDirection: optionalSortDirection(parsed.sortDirection)
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
