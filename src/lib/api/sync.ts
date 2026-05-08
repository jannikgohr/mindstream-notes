/**
 * Sync bridge. Mirror of src-tauri/src/sync/mod.rs.
 *
 * One-shot pull/push against the Etebase server. The user must already
 * be signed in (see api/auth.ts); calling this when signed out resolves
 * with an "not signed in" error from the Rust side.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { isTauri } from './index';

export interface SyncReport {
  folders_pulled: number;
  folders_pushed: number;
  notes_pulled: number;
  notes_pushed: number;
  conflicts_resolved: number;
}

export async function syncNow(): Promise<SyncReport> {
  if (!isTauri()) {
    throw new Error('Sync is only available in the desktop app.');
  }
  return await tauriInvoke<SyncReport>('sync_now');
}
