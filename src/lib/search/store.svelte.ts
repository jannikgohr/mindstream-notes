/**
 * Global open/close state for the search dialog.
 *
 * The dialog itself (mounted once at the root layout) reacts to
 * `searchDialog.open`; any caller — desktop top-bar button, mobile
 * top-bar button, hotkey, future palette — flips it through
 * `openSearch()` / `closeSearch()` / `toggleSearch()`.
 *
 * Kept tiny on purpose: search query state, debouncing, and result
 * fetching all live inside the dialog component since they don't need to
 * survive a close.
 */

export const searchDialog = $state({ open: false });

export function openSearch() {
  searchDialog.open = true;
}

export function closeSearch() {
  searchDialog.open = false;
}

export function toggleSearch() {
  searchDialog.open = !searchDialog.open;
}
