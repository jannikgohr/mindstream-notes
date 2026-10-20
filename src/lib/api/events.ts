import {
  emit as tauriEmit,
  listen as tauriListen
} from '@tauri-apps/api/event';

import type { SyncReport } from './sync';

export enum TauriEventName {
  CaptureFailed = 'capture-failed',
  CustomWindowDecorationsChanged = 'custom-window-decorations-changed',
  DesktopSettingsChanged = 'desktop-settings-changed',
  EnvironmentQuitFailed = 'environment-quit-failed',
  FullscreenNote = 'fullscreen-note',
  ImportProgress = 'import-progress',
  InvitationsChanged = 'invitations-changed',
  InviteLinkOpened = 'invite-link-opened',
  NativeMenuCommand = 'native-menu-command',
  OnboardingChanged = 'onboarding-changed',
  PluginsChanged = 'plugins-changed',
  SessionEnded = 'session-ended',
  ShowApp = 'show-app',
  SignaturesChanged = 'signatures-changed',
  SyncCompleted = 'sync-completed',
  SyncUnreachable = 'sync-unreachable',
  TrayNoteCreated = 'tray-note-created',
  UiSettingsChanged = 'ui-settings-changed',
  VaultWorkerClose = 'vault-worker-close'
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
 *   limits            — the spaces the server took nothing new for,
 *                       because a limit of the plan that pays for them
 *                       was reached. Empty when everything went up.
 *
 * Keep this enum in sync with Rust's `app_events::AppEvent`.
 */
export interface SyncCompletedPayload {
  report: SyncReport;
  notes_pulled_ids: string[];
  assets_pulled_ids: string[];
  limits?: SyncLimitReached[];
}

/**
 * A space the server took nothing new for, and the limit that stopped it.
 * Mirrors `sync::limits::LimitReached`.
 */
export interface SyncLimitReached {
  /** The server's word for the limit: `storage_full`, `item_too_large` or
   *  `plan_lapsed`. */
  reason: string;
  /** The shared folder's root. Null for the vault. */
  folder_id: string | null;
  folder_name: string | null;
  /** Whose plan the limit belongs to, when it is someone else's. */
  owner: string | null;
}

export type TauriEvents = {
  'capture-failed': { message: string };
  'environment-quit-failed': { message: string };
  'fullscreen-note': { noteId: string; title: string };
  'custom-window-decorations-changed': boolean;
  'native-menu-command': unknown;
  'sync-completed': SyncCompletedPayload;
  /**
   * Fired from Rust when the pre-sync reachability probe fails — the
   * active vault's server didn't answer. The notification bridge turns
   * this into a single "can't reach your sync server" notification.
   * Mirrors `app_events::AppEvent::SyncUnreachable`.
   */
  'sync-unreachable': { server_url: string; detail: string };
  /**
   * Progress of a running vault import. Emitted from Rust at most a few times
   * a second — the run is batched, not per-note, precisely so a fast import
   * can't flood this channel. Mirrors `app_events::AppEvent::ImportProgress`.
   */
  'import-progress': { phase: string; done: number; total: number };
  /**
   * Fired from Rust when the server says an invitation to or from this
   * account appeared or went away. The notification center lists the
   * waiting invitations again, so a folder someone just shared shows up
   * without a restart. Mirrors `app_events::AppEvent::InvitationsChanged`.
   */
  'invitations-changed': null;
  /**
   * Fired from Rust when the operating system handed the app an invite
   * link: someone clicked one outside the app. It carries nothing. The
   * window fetches the link with `takePendingInviteLink`, which hands it
   * out once. Mirrors `app_events::AppEvent::InviteLinkOpened`.
   */
  'invite-link-opened': null;
  /**
   * Fired from Rust when the server has ended this device's session and
   * the device has signed itself out: it was signed out from another
   * device, the password changed, or the account was closed. The notes
   * stay. Mirrors `app_events::AppEvent::SessionEnded`.
   */
  'session-ended': { username: string; server_url: string };
  'tray-note-created': { note_id: string };
  'show-app': null;
  /**
   * Fired by a window whenever it changes the reusable signature library
   * (add/delete). Separate note windows are separate JS contexts, so the
   * in-process store can't reach them; every window listens and re-reads the
   * (already-persisted) library when this fires. See stores/signatures.svelte.
   */
  'signatures-changed': null;
  'plugins-changed': null;
  'ui-settings-changed': null;
  'desktop-settings-changed': null;
  'onboarding-changed': null;
  'vault-worker-close': {
    id: string;
    phase: 'waiting' | 'prepare' | 'cancel';
    reason?: 'background' | 'recovery';
  };
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
