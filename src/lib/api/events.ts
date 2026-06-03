import {
  emit as tauriEmit,
  listen as tauriListen
} from '@tauri-apps/api/event';

import type { SyncReport } from './sync';

/**
 * `sync-completed` fires from Rust at the end of every `sync_now` —
 * including no-op syncs — so subscribers can refresh stale views.
 *
 *   notes_pulled_ids  — yrs_state changed; open NoteEditor /
 *                       FreeformNoteEditor merge via Y.applyUpdate
 *                       (CRDT-safe, never overwrites local edits)
 *   assets_pulled_ids — asset bytes inserted or updated; open editors
 *                       evict matching blob URLs from AssetBridge and
 *                       kick the matching image NodeView / tldraw
 *                       record so it re-resolves
 *
 * The Rust event name is hard-coded in `sync::SYNC_COMPLETED_EVENT`;
 * keep this string in sync if you change it there.
 */
export interface SyncCompletedPayload {
  report: SyncReport;
  notes_pulled_ids: string[];
  assets_pulled_ids: string[];
}

export type TauriEvents = {
  'fullscreen-note': { noteId: string; title: string };
  'sync-completed': SyncCompletedPayload;
  'tray-note-created': { note_id: string };
};

export function emit<K extends keyof TauriEvents>(
  event: K,
  payload: TauriEvents[K]
) {
  return tauriEmit(event, payload);
}

export function listen<K extends keyof TauriEvents>(
  event: K,
  handler: (payload: TauriEvents[K]) => void
) {
  return tauriListen(event, (e) => handler(e.payload as TauriEvents[K]));
}
