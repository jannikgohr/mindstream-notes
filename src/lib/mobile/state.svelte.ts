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
import { setActiveNote } from '$lib/state.svelte';

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

// ---------- Browser-history-backed navigation ----------
//
// The mobile shell's screen state used to live entirely in
// `mobileState.screen`, with no browser history involvement. That made
// the Android system back button useless: WryActivity falls back to
// `Activity.finish()` whenever `webView.canGoBack()` is false, and
// without history entries it always was.
//
// The fix is the standard SPA pattern: every navigation that changes
// `mobileState.screen` ALSO pushes a `history.pushState` entry, and a
// `popstate` listener mirrors browser-back-pops (whether triggered by
// Android, an in-app back arrow calling `navigateBack`, or the egui
// toolbar's Back button) into `setMobileScreen` + `setActiveNote`.
//
// State shape on each history entry: `{ mobileScreen: MobileScreen,
// noteId: string | null }`. Anything else still in history (e.g.
// SvelteKit's own route entries) is ignored — we read the field by
// name and fall back to 'home' if absent.

type HistoryEntry = {
  mobileScreen: MobileScreen;
  noteId: string | null;
};

let historyInstalled = false;

/**
 * Install the popstate listener and seed the current history entry
 * with a `home` state so a back press while on home doesn't fire a
 * popstate with `null` state (which would silently skip our handler
 * and let the activity finish — which IS what we want on home, but
 * we want it via a controlled path rather than a quirk of state
 * absence).
 *
 * Safe to call multiple times — only installs once. Designed to run
 * from `MobileLayout.onMount`.
 */
export function installMobileHistoryNav(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (historyInstalled) return () => {};
  historyInstalled = true;

  // Replace the current entry with a typed home state so future
  // pops back to "the initial entry" land cleanly. If the page was
  // loaded with a different initial state (deep link, reload), we
  // keep that — only seed when the field is missing.
  const current = window.history.state as HistoryEntry | null;
  if (!current || typeof current.mobileScreen !== 'string') {
    window.history.replaceState(
      { mobileScreen: 'home', noteId: null } satisfies HistoryEntry,
      ''
    );
  }

  const onPopState = (event: PopStateEvent) => {
    const state = event.state as HistoryEntry | null;
    const targetScreen: MobileScreen =
      state && typeof state.mobileScreen === 'string' ? state.mobileScreen : 'home';
    const targetNote = state?.noteId ?? null;
    // Order matters: set the note BEFORE the screen so the editor
    // mounts against the right note id. Going home is the inverse
    // — clear the note after flipping screens so the editor's
    // onDestroy sees a non-null id during its cleanup.
    if (targetScreen === 'editor') {
      if (targetNote) setActiveNote(targetNote);
      setMobileScreen('editor');
    } else {
      setMobileScreen('home');
    }
  };
  window.addEventListener('popstate', onPopState);
  return () => {
    window.removeEventListener('popstate', onPopState);
    historyInstalled = false;
  };
}

/**
 * Push a new history entry for the editor screen and switch state to
 * match. Use this from anything that "opens a note" — the home note
 * list, a wikilink follow inside another editor, the FAB after
 * creating a fresh note. Calling it while already on the same note
 * still pushes a new entry — match the existing `openNote` semantics.
 */
export function navigateToEditor(noteId: string) {
  setActiveNote(noteId);
  setMobileScreen('editor');
  if (typeof window !== 'undefined') {
    window.history.pushState(
      { mobileScreen: 'editor', noteId } satisfies HistoryEntry,
      ''
    );
  }
}

/**
 * Pop one entry off the browser history, letting the popstate
 * listener mirror the change into mobile state. This is the only
 * "go back" function code should call — the in-app back arrow, the
 * egui toolbar's Back button (via `drawing-back` event), and the
 * Android system back (already wired by WryActivity through
 * `webView.goBack()`) all converge here.
 *
 * If history is at its first entry (we're on home with nothing
 * pushed on top), `history.back()` falls through to the activity
 * back handler, which finishes the activity and closes the app —
 * the desired behaviour for "back from home".
 */
export function navigateBack() {
  if (typeof window === 'undefined') return;
  window.history.back();
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
