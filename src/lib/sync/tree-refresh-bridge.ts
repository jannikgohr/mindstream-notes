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
 * Installed once from the root layout. Refreshing on every completion (not
 * just non-empty pulls) is deliberate: a push-only sync still changes the
 * `modified` timestamps and `pushed` flags the tree renders and sorts on.
 * `loadTree` coalesces concurrent callers, so overlapping with `runSync`'s
 * own reload costs nothing.
 */

import { isTauri } from '$lib/api/core';
import { listen } from '$lib/api/events';
import { loadTree } from '$lib/stores/tree.svelte';

export function installSyncTreeRefreshBridge(): () => void {
  if (!isTauri()) return () => {};
  const unlisten = listen('sync-completed', () => {
    void loadTree();
  });
  return () => {
    void unlisten.then((off) => off());
  };
}
