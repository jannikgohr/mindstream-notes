/**
 * Shared, reactive app state. Svelte 5 runes-based singletons that any
 * component can import; `$state` makes the fields reactive.
 */

import { MOCK_NOTES, type NoteSummary } from './mocks';

interface UiState {
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  /** Id of the note the metadata panel should describe. */
  activeNoteId: string | null;
}

interface NotesState {
  /** id -> in-memory note. Replace with disk-backed store later. */
  byId: Record<string, NoteSummary>;
}

export const ui = $state<UiState>({
  leftSidebarOpen: true,
  rightSidebarOpen: true,
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
}

export function toggleRightSidebar() {
  ui.rightSidebarOpen = !ui.rightSidebarOpen;
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
