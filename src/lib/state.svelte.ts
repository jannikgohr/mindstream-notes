/**
 * Cross-component UI state. Notes and the file tree have moved to
 * `$lib/stores/tree.svelte` (which is hydrated from the Rust API);
 * this file is now strictly window/sidebar/sort UI.
 */

import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  savePreferences,
  normalizePreferences,
  UI_PREFERENCE_IDS,
  type Preferences
} from './preferences';
import { isTauri } from '$lib/api/core';
import { pushToast } from '$lib/components/toast.svelte';
import { tUi } from '$lib/settings/i18n.svelte';
import type { SortDirection, SortStrategy } from './sort';

const initialPrefs = loadPreferences();

interface UiState {
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  sortStrategy: SortStrategy;
  sortDirection: SortDirection;
  /** Id of the note the metadata panel should describe. */
  activeNoteId: string | null;
}

export const ui = $state<UiState>({
  leftSidebarOpen: initialPrefs.leftSidebarOpen,
  rightSidebarOpen: initialPrefs.rightSidebarOpen,
  leftSidebarWidth: initialPrefs.leftSidebarWidth,
  rightSidebarWidth: initialPrefs.rightSidebarWidth,
  sortStrategy: initialPrefs.sortStrategy,
  sortDirection: initialPrefs.sortDirection,
  activeNoteId: null
});

let nativeWriter: ((id: string, value: unknown) => Promise<void>) | null = null;

export function registerNativeUiPreferenceWriter(
  writer: (id: string, value: unknown) => Promise<void>
): void {
  nativeWriter = writer;
}

export function applyNativeUiPreferences(
  values: Record<string, unknown>
): void {
  const raw = Object.fromEntries(
    Object.entries(UI_PREFERENCE_IDS).map(([key, id]) => [key, values[id]])
  );
  Object.assign(ui, normalizePreferences(raw));
}

function setPreference<K extends keyof Preferences>(
  key: K,
  value: Preferences[K]
): Promise<void> {
  const preferences: Preferences = ui;
  const previous = preferences[key];
  preferences[key] = value;
  if (!isTauri()) {
    persistUi();
    return Promise.resolve();
  }
  const task = nativeWriter
    ? nativeWriter(UI_PREFERENCE_IDS[key], value)
    : Promise.reject(new Error('UI preferences have not initialized'));
  // Event callbacks can ignore the returned promise; bindings await it. Both
  // paths get rollback and visible feedback without an unhandled rejection.
  void task.catch((err) => {
    if (!nativeWriter && preferences[key] === value)
      preferences[key] = previous;
    console.error('[preferences] field save failed', key, err);
    pushToast(tUi('preferences.saveFailed'), {
      variant: 'error'
    });
  });
  return task;
}

export function setActiveNote(id: string | null) {
  ui.activeNoteId = id;
}

export function toggleLeftSidebar() {
  return setPreference('leftSidebarOpen', !ui.leftSidebarOpen);
}

export function toggleRightSidebar() {
  return setPreference('rightSidebarOpen', !ui.rightSidebarOpen);
}

export function openRightSidebar() {
  if (ui.rightSidebarOpen) return;
  return setPreference('rightSidebarOpen', true);
}

export function setLeftSidebarWidth(px: number) {
  return setPreference('leftSidebarWidth', px);
}

export function setRightSidebarWidth(px: number) {
  return setPreference('rightSidebarWidth', px);
}

export function setSortStrategy(s: SortStrategy) {
  return setPreference('sortStrategy', s);
}

export function setSortDirection(d: SortDirection) {
  return setPreference('sortDirection', d);
}

export function toggleSortDirection() {
  return setSortDirection(ui.sortDirection === 'asc' ? 'desc' : 'asc');
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistUi() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    savePreferences({
      ...DEFAULT_PREFERENCES,
      leftSidebarOpen: ui.leftSidebarOpen,
      rightSidebarOpen: ui.rightSidebarOpen,
      leftSidebarWidth: ui.leftSidebarWidth,
      rightSidebarWidth: ui.rightSidebarWidth,
      sortStrategy: ui.sortStrategy,
      sortDirection: ui.sortDirection
    });
  }, 150);
}
