/**
 * Single entry point for "run a sync" — wraps the raw `syncNow` Tauri
 * call so callers also get an automatic tree refresh, and so the manual
 * "Sync now" button and the periodic timer in +layout.svelte don't
 * step on each other.
 *
 * Coalescing: if a sync is already running and another caller fires,
 * they both await the same Promise instead of starting a second
 * server round-trip. This matters because `loadTree()` is the
 * side-effect that updates the UI; running it twice in parallel from
 * two racing pulls would hammer the Rust DB connection for no reason.
 */

import { syncNow, type SyncReport } from '$lib/api/sync';
import { loadTree } from '$lib/stores/tree.svelte';

let inflight: Promise<SyncReport> | null = null;

export async function runSync(): Promise<SyncReport> {
  if (inflight) return await inflight;
  inflight = (async () => {
    try {
      const report = await syncNow();
      // Always refresh — even with zero pulls, a push could have changed
      // a `modified` timestamp that the file tree's sort depends on.
      await loadTree();
      return report;
    } finally {
      inflight = null;
    }
  })();
  return await inflight;
}
