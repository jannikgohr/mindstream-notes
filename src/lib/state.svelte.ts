/**
 * Cross-component UI state. Notes and the file tree have moved to
 * `$lib/stores/tree.svelte` (which is hydrated from the Rust API);
 * this file is now strictly window/sidebar/sort UI.
 */

import { DEFAULT_PREFERENCES, loadPreferences, savePreferences } from './preferences';
import type { SortStrategy } from './sort';

const initialPrefs = loadPreferences();

interface UiState {
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  sortStrategy: SortStrategy;
  /** Id of the note the metadata panel should describe. */
  activeNoteId: string | null;
}

export const ui = $state<UiState>({
  leftSidebarOpen: initialPrefs.leftSidebarOpen,
  rightSidebarOpen: initialPrefs.rightSidebarOpen,
  leftSidebarWidth: initialPrefs.leftSidebarWidth,
  rightSidebarWidth: initialPrefs.rightSidebarWidth,
  sortStrategy: initialPrefs.sortStrategy,
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
      sortStrategy: ui.sortStrategy
    });
  }, 150);
}
