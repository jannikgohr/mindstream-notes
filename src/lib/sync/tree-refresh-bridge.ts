/**
 * `sync-completed` → file tree refresh.
 *
 * `runSync` reloads the tree itself, so anything the UI kicks off (the
 * "Sync now" button, post-create pushes) already lands in the sidebar. The
 * *scheduled* sync, though, runs entirely in Rust: it pulls remote changes
 * into the DB and emits `sync-completed`, and until this bridge existed
 * nothing on the JS side reacted — so a note created on another device only
 * showed up after a manual sync (or an app restart).
 *
 * Installed once from the root layout. Rust compares the tree before and
 * after each sync, because a push-only sync still changes the `pushed` flags
 * the tree renders, so the report's pull counts can't tell. `loadTree`
 * coalesces concurrent callers, so overlapping with `runSync`'s own reload
 * costs nothing. A hidden window reloads once when it is shown.
 */

import { isTauri } from '$lib/api/core';
import { listen, TauriEventName } from '$lib/api/events';
import { deferWhileHidden } from '$lib/defer-while-hidden';
import { applyNoteChange, loadTree } from '$lib/stores/tree.svelte';

export function installSyncTreeRefreshBridge(): () => void {
  if (!isTauri()) return () => {};
  const refresh = deferWhileHidden(() => void loadTree());
  const unlisten = listen(TauriEventName.SyncCompleted, (sync) => {
    if (sync.tree_changed) refresh.request();
  });
  // A rename or edit in a note window, or in the main window while a note
  // window is open. Each window holds its own tree, so the others would
  // keep the old title and `modified` stamp until a reload.
  const unlistenNotes = listen(TauriEventName.NoteSummaryChanged, (change) => {
    applyNoteChange(change);
  });
  return () => {
    refresh.dispose();
    void unlisten.then((off) => off());
    void unlistenNotes.then((off) => off());
  };
}
