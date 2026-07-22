import {
  emit as tauriEmit,
  listen as tauriListen
} from '@tauri-apps/api/event';

import type { SyncReport } from './sync';

export enum TauriEventName {
  CollabCredentialsChanged = 'collab-credentials-changed',
  CustomWindowDecorationsChanged = 'custom-window-decorations-changed',
  FullscreenNote = 'fullscreen-note',
  NativeMenuCommand = 'native-menu-command',
  ShowApp = 'show-app',
  SignaturesChanged = 'signatures-changed',
  SyncCompleted = 'sync-completed',
  SyncUnreachable = 'sync-unreachable',
  TrayNoteCreated = 'tray-note-created'
}

export type TauriEventKey = `${TauriEventName}`;

/**
 * `TauriEventName.SyncCompleted` fires from Rust at the end of every `sync_now` —
 * including no-op syncs — so subscribers can refresh stale views.
 *
 *   notes_pulled_ids  — yrs_state changed; open NoteEditor /
 *                       FreeformNoteEditor merge via Y.applyUpdate
 *                       (CRDT-safe, never overwrites local edits)
 *   assets_pulled_ids — asset bytes inserted or updated; open editors
 *                       evict matching blob URLs from AssetBridge and
 *                       kick matching image views so they re-resolve
 *
 * Keep this enum in sync with Rust's `app_events::AppEvent`.
 */
export interface SyncCompletedPayload {
  report: SyncReport;
  notes_pulled_ids: string[];
  assets_pulled_ids: string[];
}

export interface CollabCredentialsChangedPayload {
  note_ids: string[];
}

export type TauriEvents = {
  'fullscreen-note': { noteId: string; title: string };
  'custom-window-decorations-changed': boolean;
  'native-menu-command': unknown;
  'sync-completed': SyncCompletedPayload;
  /**
   * Fired when a shared collection's live-collab epoch/salt changes.
   * Open note editors whose note id appears here must recreate their
   * active relay client so removed members stay stranded in the old room.
   * Mirrors `app_events::AppEvent::CollabCredentialsChanged`.
   */
  'collab-credentials-changed': CollabCredentialsChangedPayload;
  /**
   * Fired from Rust when the pre-sync reachability probe fails — the
   * active vault's server didn't answer. The notification bridge turns
   * this into a single "can't reach your sync server" notification.
   * Mirrors `app_events::AppEvent::SyncUnreachable`.
   */
  'sync-unreachable': { server_url: string; detail: string };
  'tray-note-created': { note_id: string };
  'show-app': null;
  /**
   * Fired by a window whenever it changes the reusable signature library
   * (add/delete). Separate note windows are separate JS contexts, so the
   * in-process store can't reach them; every window listens and re-reads the
   * (already-persisted) library when this fires. See stores/signatures.svelte.
   */
  'signatures-changed': null;
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
