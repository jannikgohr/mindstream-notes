/**
 * Mobile-only UI state.
 *
 * Kept in its own module so the desktop shell's state.svelte.ts stays
 * untouched. The mobile shell is a single-screen-at-a-time UI driven
 * by `screen` (home note browser vs full editor) and `view` (which
 * bottom-nav tab is active).
 *
 * Display mode is a user-local UI choice (no need to sync across
 * devices) so it rides localStorage. The favourite bit, by contrast,
 * lives on each note in SQLite + the v2 NotePayload so it survives
 * reinstalls and crosses devices — this module just funnels reads
 * and writes through the tree store.
 */

import { setNoteFavourite } from '$lib/stores/tree.svelte';
import { tree } from '$lib/stores/tree.svelte';

const DISPLAY_MODE_KEY = 'notes-app:mobile:displayMode';
const LEGACY_FAVOURITES_KEY = 'notes-app:mobile:favourites';

export type MobileScreen = 'home' | 'editor';

/**
 * Bottom-nav buckets. Add a new entry here + a matching filter in
 * MobileNoteList and an icon in MobileBottomNav to extend.
 */
export type MobileView = 'home' | 'shared' | 'favourite' | 'trash';

export type DisplayMode = 'list' | 'grid';

interface MobileState {
  screen: MobileScreen;
  view: MobileView;
  /**
   * Folder the home/trash view is drilled into. null = the view's root.
   * Reset to null whenever the bottom-nav view switches so the user
   * doesn't land deep in a folder they navigated through earlier.
   */
  currentFolderId: string | null;
  displayMode: DisplayMode;
  searchQuery: string;
  /** Whether the FAB's secondary actions are revealed. */
  fabExpanded: boolean;
}

function loadDisplayMode(): DisplayMode {
  if (typeof localStorage === 'undefined') return 'list';
  const raw = localStorage.getItem(DISPLAY_MODE_KEY);
  return raw === 'grid' ? 'grid' : 'list';
}

export const mobileState = $state<MobileState>({
  screen: 'home',
  view: 'home',
  currentFolderId: null,
  displayMode: loadDisplayMode(),
  searchQuery: '',
  fabExpanded: false
});

/**
 * Backend-backed read. Returns the `favourite` field from the note
 * summary in the tree store; `false` when the note isn't loaded yet.
 */
export function isFavourite(noteId: string): boolean {
  return tree.notesById[noteId]?.favourite === true;
}

/**
 * Flip the favourite bit and persist via the tree store (which calls
 * save_note in Rust). Optimistic — the local tree.notesById entry is
 * patched immediately so the star fills before the round-trip
 * completes.
 */
export function toggleFavourite(noteId: string) {
  const current = isFavourite(noteId);
  void setNoteFavourite(noteId, !current);
}

/**
 * One-shot migration: hoist any localStorage favourites left over from
 * the pre-database mobile build into the backend, then clear the key.
 * Safe to call on every load — the predicate skips notes that are
 * already favourited and waits until the tree is hydrated.
 */
export async function migrateLegacyFavourites(): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  const raw = localStorage.getItem(LEGACY_FAVOURITES_KEY);
  if (!raw) return;
  let ids: string[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      localStorage.removeItem(LEGACY_FAVOURITES_KEY);
      return;
    }
    ids = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    localStorage.removeItem(LEGACY_FAVOURITES_KEY);
    return;
  }
  for (const id of ids) {
    const note = tree.notesById[id];
    if (!note || note.favourite) continue;
    try {
      await setNoteFavourite(id, true);
    } catch (err) {
      console.warn('[mobile] failed to migrate favourite for', id, err);
    }
  }
  localStorage.removeItem(LEGACY_FAVOURITES_KEY);
}

export function setMobileScreen(screen: MobileScreen) {
  mobileState.screen = screen;
  if (screen === 'home') mobileState.fabExpanded = false;
}

export function setMobileView(view: MobileView) {
  if (mobileState.view !== view) {
    // Drop folder drill-down when switching buckets so the user lands at
    // the view's root rather than inside whatever folder they last
    // browsed in the previous bucket.
    mobileState.currentFolderId = null;
  }
  mobileState.view = view;
  mobileState.fabExpanded = false;
}

export function setCurrentFolder(id: string | null) {
  mobileState.currentFolderId = id;
}

export function setDisplayMode(mode: DisplayMode) {
  mobileState.displayMode = mode;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(DISPLAY_MODE_KEY, mode);
  }
}

export function setSearchQuery(q: string) {
  mobileState.searchQuery = q;
}

export function toggleFabExpanded() {
  mobileState.fabExpanded = !mobileState.fabExpanded;
}

export function collapseFab() {
  mobileState.fabExpanded = false;
}
