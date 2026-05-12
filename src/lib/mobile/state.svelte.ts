/**
 * Mobile-only UI state.
 *
 * Kept in its own module so the desktop shell's state.svelte.ts stays
 * untouched. The mobile shell is a single-screen-at-a-time UI driven
 * by `screen` (home note browser vs full editor) and `view` (which
 * bottom-nav tab is active).
 *
 * Persisted bits (display mode, favourites) round-trip through
 * localStorage so they survive reloads without bothering the Rust
 * preferences blob — those are user-local UI choices, not project
 * data.
 */

const FAVOURITES_KEY = 'notes-app:mobile:favourites';
const DISPLAY_MODE_KEY = 'notes-app:mobile:displayMode';

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

function loadFavourites(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(FAVOURITES_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
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
 * Favourite-note set. Stored separately from `mobileState` because Svelte's
 * deep $state proxy doesn't reactively track Set mutation — we hold the
 * Set as the value of a reactive container and reassign on every change
 * so derived expressions update correctly.
 */
export const favourites = $state<{ ids: Set<string> }>({
  ids: loadFavourites()
});

function persistFavourites() {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(FAVOURITES_KEY, JSON.stringify([...favourites.ids]));
}

export function isFavourite(noteId: string): boolean {
  return favourites.ids.has(noteId);
}

export function toggleFavourite(noteId: string) {
  const next = new Set(favourites.ids);
  if (next.has(noteId)) next.delete(noteId);
  else next.add(noteId);
  favourites.ids = next;
  persistFavourites();
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
