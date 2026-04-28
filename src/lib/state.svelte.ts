/**
 * Shared, reactive app state. Svelte 5 runes singletons that any component
 * can import; `$state` makes the fields reactive.
 */

import { MOCK_NOTES, type NoteSummary } from './mocks';
import { DEFAULT_PREFERENCES, loadPreferences, savePreferences } from './preferences';

// Hydrate UI state from persisted preferences (or defaults on the server /
// first run). `loadPreferences` is browser-only and returns defaults on the
// server, so this is safe under SvelteKit's prerender pass.
const initialPrefs = loadPreferences();

interface UiState {
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  /** Id of the note the metadata panel should describe. */
  activeNoteId: string | null;
}

interface NotesState {
  /** id -> in-memory note. Replace with disk-backed store later. */
  byId: Record<string, NoteSummary>;
}

export const ui = $state<UiState>({
  leftSidebarOpen: initialPrefs.leftSidebarOpen,
  rightSidebarOpen: initialPrefs.rightSidebarOpen,
  leftSidebarWidth: initialPrefs.leftSidebarWidth,
  rightSidebarWidth: initialPrefs.rightSidebarWidth,
  activeNoteId: 'welcome'
});

export const notes = $state<NotesState>({
  byId: { ...MOCK_NOTES }
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

export function updateNoteBody(id: string, body: string) {
  const existing = notes.byId[id];
  if (!existing) return;
  notes.byId[id] = {
    ...existing,
    body,
    modified: new Date().toISOString()
  };
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistUi() {
  // Debounced — drag-resize fires many updates per second.
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    savePreferences({
      ...DEFAULT_PREFERENCES,
      leftSidebarOpen: ui.leftSidebarOpen,
      rightSidebarOpen: ui.rightSidebarOpen,
      leftSidebarWidth: ui.leftSidebarWidth,
      rightSidebarWidth: ui.rightSidebarWidth
    });
  }, 150);
}
