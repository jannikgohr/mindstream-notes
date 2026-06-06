/**
 * Open / close state for the shortcut-help overlay.
 *
 * Mirrors the `settingsDialog` pattern in `$lib/settings/store.svelte` —
 * a single module-level `$state` flag flipped by helper functions so
 * the global command's `run()` callback and the dialog component
 * share the same reactive surface without prop drilling.
 *
 * The dialog itself ([`ShortcutHelpDialog.svelte`](../components/ShortcutHelpDialog.svelte))
 * is mounted once at the root layout; it reads `shortcutHelp.open`
 * and renders / unmounts accordingly. Anything anywhere in the app
 * can call `openShortcutHelp()` to surface the cheat sheet.
 */

export const shortcutHelp = $state({ open: false });

export function openShortcutHelp(): void {
  shortcutHelp.open = true;
}

export function closeShortcutHelp(): void {
  shortcutHelp.open = false;
}
