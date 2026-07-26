/**
 * Global open/close state for the command palette.
 *
 * Mirrors `$lib/search/store.svelte` — a single module-level `$state`
 * flag flipped by helper functions so the `global.openCommandPalette`
 * command's `run()` callback, the top-bar button, and the dialog
 * component all share one reactive surface without prop drilling.
 *
 * The dialog itself (`CommandPalette.svelte`) is mounted once at the root
 * layout via `LazyRootSingletons`; it reads `commandPalette.open` and
 * renders / unmounts accordingly. The command list, query, and selection
 * all live inside the dialog since none of that needs to survive a close.
 */

export const commandPalette = $state({ open: false });

export function openCommandPalette() {
  commandPalette.open = true;
}

export function closeCommandPalette() {
  commandPalette.open = false;
}

export function toggleCommandPalette() {
  commandPalette.open = !commandPalette.open;
}
