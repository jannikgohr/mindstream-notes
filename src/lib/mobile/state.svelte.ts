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

import { pushState } from '$app/navigation';
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

export type MobileBatchItem =
  | { kind: 'note'; id: string }
  | { kind: 'folder'; id: string };

interface MobileBatchSelectionState {
  active: boolean;
  items: MobileBatchItem[];
}

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
  fabExpanded: false
});

export const mobileBatchSelection = $state<MobileBatchSelectionState>({
  active: false,
  items: []
});

export function mobileBatchKey(item: MobileBatchItem): string {
  return `${item.kind}:${item.id}`;
}

export function isMobileBatchSelected(item: MobileBatchItem): boolean {
  const key = mobileBatchKey(item);
  return mobileBatchSelection.items.some(
    (selected) => mobileBatchKey(selected) === key
  );
}

export function setMobileBatchSelection(items: MobileBatchItem[]) {
  const seen = new Set<string>();
  mobileBatchSelection.active = true;
  mobileBatchSelection.items = items.filter((item) => {
    const key = mobileBatchKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function toggleMobileBatchItem(item: MobileBatchItem) {
  const key = mobileBatchKey(item);
  if (isMobileBatchSelected(item)) {
    mobileBatchSelection.items = mobileBatchSelection.items.filter(
      (selected) => mobileBatchKey(selected) !== key
    );
  } else {
    setMobileBatchSelection([...mobileBatchSelection.items, item]);
  }
}

export function clearMobileBatchSelection() {
  mobileBatchSelection.active = false;
  mobileBatchSelection.items = [];
}

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
  if (screen === 'editor') clearMobileBatchSelection();
}

// ---------- Browser-history-backed navigation ----------
//
// The mobile shell's screen state used to live entirely in
// `mobileState.screen`, with no browser history involvement. That made
// the Android system back button useless: WryActivity falls back to
// `Activity.finish()` whenever `webView.canGoBack()` is false, and
// without history entries it always was.
//
// The nav is now a small stack: a base level (the home browser and the
// editor, whose forward navigations — opening a note, following a
// wikilink, drilling into a folder, switching bucket — each push a
// `backStack` snapshot) with zero or more dismissible **overlays** on top
// (the options menu's settings / notifications / vault surfaces).
// Every level owns one browser-history entry, so the Android system
// back button pops them one at a time — closing the top overlay first,
// then walking the base back-stack (note chain / folders / buckets), and
// only then falling through to the activity's own back handler (which
// finishes the app).
//
// Why SvelteKit's `pushState` and not `window.history.pushState`:
// SvelteKit wraps the history API to drive its own client-side
// router, and direct calls trigger an `Avoid using history.pushState`
// warning at runtime. SvelteKit's `pushState` calls into the same
// underlying history API but coordinates with the router. The url
// argument is `''` because we don't want SvelteKit to navigate to a
// new route — just record a history entry our popstate handler can
// pop.

let historyInstalled = false;

/** A dismissible full-screen surface stacked above the base nav. */
interface NavOverlay {
  id: string;
  close: () => void;
}

// The live overlay stack, innermost (base) → outermost (topmost). Not
// reactive: it's control-flow bookkeeping, read only by the popstate
// handler and the open/close helpers.
let overlayStack: NavOverlay[] = [];

// A snapshot of the base-level nav state — either a home screen browsing
// a bucket + folder, or the editor showing a note. The base back-stack is
// a list of these, oldest → newest.
type BaseSnapshot =
  | { screen: 'home'; view: MobileView; folderId: string | null }
  | { screen: 'editor'; noteId: string };

// The base-level back-stack, oldest → newest: the states to restore as
// the system back button walks backwards. `currentBase` is the live state
// NOT on the stack. Every forward navigation — opening a note (incl. a
// wikilink follow), drilling into a folder, switching bucket — pushes the
// state it's *leaving* here and a matching browser-history entry, so the
// two stay index-for-index aligned. A base-level back pop restores the top
// snapshot: the previous note in a followed-link chain, the parent folder,
// the previous bucket — and only falls through to the activity's own back
// handler (which finishes the app) once the stack is empty. Not reactive:
// restores are mirrored into mobileState / ui via the setters below.
let backStack: BaseSnapshot[] = [];
let currentBase: BaseSnapshot = {
  screen: 'home',
  view: 'home',
  folderId: null
};

/**
 * Record the current base state on the back-stack and push a matching
 * history entry, in preparation for moving to `next`. Call this from
 * every forward base-level navigation, then apply `next` to mobileState.
 * Keeps `backStack.length` equal to the pushed-history depth so a popstate
 * pops exactly one level.
 */
function pushBase(next: BaseSnapshot): void {
  backStack.push(currentBase);
  currentBase = next;
  if (typeof window !== 'undefined') {
    // Empty URL = keep the current SvelteKit route (we're not
    // route-navigating, just recording a history entry the popstate
    // handler can pop). The handler reads backStack, so the state object
    // stays empty.
    pushState('', {});
  }
}

/** Apply a popped snapshot back onto mobileState / the active note. */
function restoreBase(snapshot: BaseSnapshot): void {
  currentBase = snapshot;
  clearMobileBatchSelection();
  if (snapshot.screen === 'editor') {
    setActiveNote(snapshot.noteId);
    setMobileScreen('editor');
  } else {
    mobileState.view = snapshot.view;
    mobileState.currentFolderId = snapshot.folderId;
    setMobileScreen('home');
  }
}

// True while the popstate handler is invoking an overlay's `close()`.
// Its `onOpenChange`/close button then calls `closeNavOverlay`, and this
// flag tells that call the history entry is already being consumed by
// the pop — so it must NOT issue its own `history.back()`.
let poppingOverlayFromHistory = false;

// How many upcoming popstates are bookkeeping pops that a UI-initiated
// `closeNavOverlay` fired via `history.back()` to reclaim a dangling
// history entry. Those pops are pure bookkeeping — the overlay is already
// closed — so the handler swallows one per count instead of treating it
// as a real "back". A counter (not a bool) because nested overlays can be
// dismissed in the same tick (e.g. closing settings while drilled into a
// category collapses both levels at once), firing more than one reclaim.
let pendingReclaimPops = 0;

/**
 * Open a dismissible overlay as a new nav level: record a history entry
 * and register `close` so the system back button (or another overlay
 * opening) can dismiss it. `close` must actually hide the surface (flip
 * its `open` flag) — it runs when the entry is popped.
 *
 * Pair every `openNavOverlay` with a `closeNavOverlay(id)` from the
 * surface's own dismissal path (X button, backdrop, Escape) so a
 * UI-driven close keeps the history in lockstep.
 */
export function openNavOverlay(id: string, close: () => void): void {
  if (typeof window === 'undefined') return;
  overlayStack.push({ id, close });
  pushState('', {});
}

/**
 * Remove an overlay from the stack in response to it being dismissed by
 * its own UI. When this isn't already running inside a history pop, it
 * reclaims the dangling history entry with `history.back()` (swallowed
 * by `suppressNextPop`) so the browser depth matches the stack. No-op if
 * the overlay was already popped (e.g. the system back button closed
 * it), which keeps double-dismissal idempotent.
 */
export function closeNavOverlay(id: string): void {
  const idx = overlayStack.findIndex((o) => o.id === id);
  if (idx === -1) return;
  overlayStack.splice(idx, 1);
  if (!poppingOverlayFromHistory && typeof window !== 'undefined') {
    pendingReclaimPops += 1;
    window.history.back();
  }
}

/**
 * Install the popstate listener. Safe to call multiple times — only
 * installs once. Designed to run from `MobileLayout.onMount`.
 */
export function installMobileHistoryNav(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (historyInstalled) return () => {};
  historyInstalled = true;
  // Fresh mount = fresh nav; drop any base stack left by a prior shell and
  // reset the live state to the home root.
  backStack = [];
  currentBase = { screen: 'home', view: 'home', folderId: null };

  const onPopState = () => {
    // A bookkeeping pop from a UI-initiated overlay close — already
    // handled, so consume it (one per pending reclaim) without touching
    // nav state.
    if (pendingReclaimPops > 0) {
      pendingReclaimPops -= 1;
      return;
    }
    // Topmost overlay first: dismiss it and stop, leaving the base
    // screen (home or editor) untouched underneath.
    if (overlayStack.length > 0) {
      const top = overlayStack.pop()!;
      poppingOverlayFromHistory = true;
      try {
        top.close();
      } finally {
        poppingOverlayFromHistory = false;
      }
      return;
    }
    // No overlays: walk the base-nav stack. Restore the previous base
    // state — the earlier note in a followed-link chain, the parent
    // folder, the previous bucket. Only once the stack drains do we fall
    // back to the home root.
    if (backStack.length > 0) {
      restoreBase(backStack.pop()!);
      return;
    }
    setMobileScreen('home');
  };
  window.addEventListener('popstate', onPopState);
  return () => {
    window.removeEventListener('popstate', onPopState);
    historyInstalled = false;
    overlayStack = [];
    backStack = [];
    currentBase = { screen: 'home', view: 'home', folderId: null };
    poppingOverlayFromHistory = false;
    pendingReclaimPops = 0;
  };
}

/**
 * Push a new history entry for the editor screen and switch state
 * to match. Use this from anything that "opens a note" — the home
 * note list, a wikilink follow, the FAB after creating a fresh
 * note. Calling it while already on the same note still pushes a
 * new entry, matching the existing `openNote` semantics.
 */
export function navigateToEditor(noteId: string) {
  // Record where we were (home+folder, or the previous note) so a
  // system-back pop restores it, then switch to the note.
  pushBase({ screen: 'editor', noteId });
  clearMobileBatchSelection();
  setActiveNote(noteId);
  setMobileScreen('editor');
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
    // Switching buckets is a forward nav: record the current bucket+folder
    // so back returns to it, then land at the new bucket's root (drop the
    // folder drill-down so the user doesn't stay inside a folder from the
    // previous bucket).
    pushBase({ screen: 'home', view, folderId: null });
    mobileState.currentFolderId = null;
    clearMobileBatchSelection();
  }
  mobileState.view = view;
  mobileState.fabExpanded = false;
}

export function setCurrentFolder(id: string | null) {
  if (id === mobileState.currentFolderId) {
    clearMobileBatchSelection();
    return;
  }
  // Drilling into a subfolder or jumping via the breadcrumb is a forward
  // nav: record the current folder so the system back button steps back
  // out one level at a time.
  pushBase({ screen: 'home', view: mobileState.view, folderId: id });
  mobileState.currentFolderId = id;
  clearMobileBatchSelection();
}

export function setDisplayMode(mode: DisplayMode) {
  mobileState.displayMode = mode;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(DISPLAY_MODE_KEY, mode);
  }
}

export function toggleFabExpanded() {
  mobileState.fabExpanded = !mobileState.fabExpanded;
}

export function collapseFab() {
  mobileState.fabExpanded = false;
}
