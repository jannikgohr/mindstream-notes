/**
 * Cross-component UI state. Notes and the file tree have moved to
 * `$lib/stores/tree.svelte` (which is hydrated from the Rust API);
 * this file is now strictly window/sidebar/sort UI.
 */

import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  savePreferences
} from './preferences';
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

export function setActiveNote(id: string | null) {
  ui.activeNoteId = id;
}

export function toggleLeftSidebar() {
  ui.leftSidebarOpen = !ui.leftSidebarOpen;
  persistUi();
}

export function toggleRightSidebar() {
  ui.rightSidebarOpen = !ui.rightSidebarOpen;
  persistUi();
}

export function setLeftSidebarWidth(px: number) {
  ui.leftSidebarWidth = px;
  persistUi();
}

export function setRightSidebarWidth(px: number) {
  ui.rightSidebarWidth = px;
  persistUi();
}

export function setSortStrategy(s: SortStrategy) {
  ui.sortStrategy = s;
  persistUi();
}

export function setSortDirection(d: SortDirection) {
  ui.sortDirection = d;
  persistUi();
}

export function toggleSortDirection() {
  setSortDirection(ui.sortDirection === 'asc' ? 'desc' : 'asc');
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
