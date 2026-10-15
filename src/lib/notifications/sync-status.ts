/**
 * Sync reachability → notification bridge.
 *
 * Rust runs a reachability probe before every sync (manual + scheduled)
 * and, on a transport failure, emits `sync-unreachable` instead of
 * fanning out into a storm of failing requests. This module turns that
 * signal into a single "can't reach your sync server" notification, and
 * clears it again on the next successful `sync-completed`.
 *
 * The notification is tappable: `onOpen` retries a manual sync, so the
 * user can dismiss-by-fixing (reconnect VPN / network, then tap). A
 * successful retry emits `sync-completed`, which clears it; a failed one
 * re-emits `sync-unreachable`, which just refreshes it in place.
 */

import { refreshAuthSession } from '$lib/api/auth.svelte';
import { isTauri } from '$lib/api/core';
import { listen, TauriEventName } from '$lib/api/events';
import type { SyncLimitReached } from '$lib/api/events';
import { syncNow } from '$lib/api/sync';
import { tUi, tUiFormat } from '$lib/settings/i18n.svelte';
import {
  clearNotificationsByKind,
  dismissNotification,
  notificationState,
  upsertNotification
} from './store.svelte';

const SYNC_OFFLINE_KIND = 'sync-offline' as const;
/** Stable id so repeated probes refresh one notification, not stack. */
const SYNC_OFFLINE_ID = 'sync:offline';

/**
 * Surface (or refresh) the "server unreachable" notification for
 * `serverUrl`. Idempotent — the stable id means a second failing probe
 * updates the existing entry rather than adding another.
 */
export function reportServerUnreachable(serverUrl: string): void {
  upsertNotification({
    id: SYNC_OFFLINE_ID,
    kind: SYNC_OFFLINE_KIND,
    widgetType: 'generic',
    createdAt: Date.now(),
    data: {
      title: tUi('notifications.sync.offline.title'),
      message: tUi('notifications.sync.offline.message').replace(
        '{server}',
        serverUrl
      )
    },
    onOpen: async () => {
      // Retry: if the server is back, `sync-completed` clears this; if
      // it's still down, the preflight re-fires `sync-unreachable` and
      // the notification simply refreshes.
      try {
        await syncNow();
      } catch {
        /* still offline — leave the notification in place */
      }
    }
  });
}

/** Drop the offline notification (the server answered again). */
export function clearServerUnreachable(): void {
  clearNotificationsByKind(SYNC_OFFLINE_KIND);
}

const SESSION_ENDED_KIND = 'session-ended' as const;
/** Stable id: a device is signed out once, however often it is told. */
const SESSION_ENDED_ID = 'sync:session-ended';

/**
 * Tell the user the server ended this device's session and the device has
 * signed itself out. It happens without them doing anything here, so
 * without a word the app would only look as if sync had stopped working.
 */
export function reportSessionEnded(serverUrl: string): void {
  upsertNotification({
    id: SESSION_ENDED_ID,
    kind: SESSION_ENDED_KIND,
    widgetType: 'generic',
    createdAt: Date.now(),
    data: {
      title: tUi('notifications.sync.signedOut.title'),
      message: tUi('notifications.sync.signedOut.message').replace(
        '{server}',
        serverUrl
      )
    }
  });
}

/** Drop the signed-out notification (the device is syncing again). */
export function clearSessionEnded(): void {
  clearNotificationsByKind(SESSION_ENDED_KIND);
}

const SYNC_LIMIT_KIND = 'sync-limit' as const;

/** The `ui` entries for each limit the server names. A limit this app has
 *  no sentence for gets the last one, which says no more than that there
 *  is one. */
const LIMIT_SENTENCES: Record<string, string> = {
  storage_full: 'notifications.sync.limit.storageFull',
  plan_lapsed: 'notifications.sync.limit.planLapsed',
  item_too_large: 'notifications.sync.limit.itemTooLarge'
};
const OTHER_LIMIT = 'notifications.sync.limit.other';

/** Every `ui` key the limit notice can ask for, so a test can check the
 *  bundles have them all. */
export const SYNC_LIMIT_UI_KEYS: readonly string[] = [
  ...[...Object.values(LIMIT_SENTENCES), OTHER_LIMIT].flatMap((base) => [
    `${base}.title`,
    `${base}.message`,
    `${base}.theirTitle`,
    `${base}.theirMessage`
  ]),
  'notifications.sync.limit.unnamedFolder'
];

/** One notice for the account's own plan, whichever of its spaces ran into
 *  it, and one for each folder that runs on someone else's. */
function limitId(limit: SyncLimitReached): string {
  return limit.owner === null
    ? `sync:limit:own:${limit.reason}`
    : `sync:limit:${limit.folder_id ?? ''}:${limit.reason}`;
}

/**
 * Say which limits the last sync ran into, and take back what an earlier
 * sync said that no longer holds.
 *
 * Nothing is lost when a limit is reached: the changes stay on the device
 * and go up once there is room. But the app would look as if it synced, so
 * this says that it did not, and whose plan it is. In a shared folder that
 * is the owner's, and the person typing can only ask them.
 */
export function reportSyncLimits(limits: readonly SyncLimitReached[]): void {
  const current = new Set(limits.map(limitId));
  for (const item of notificationState.items) {
    if (item.kind === SYNC_LIMIT_KIND && !current.has(item.id)) {
      dismissNotification(item.id);
    }
  }
  for (const limit of limits) {
    const id = limitId(limit);
    // A notice that is already up stays where it is, with its first time.
    // Every sync reports the limit again for as long as it holds.
    const shown = notificationState.items.find((item) => item.id === id);
    const base = LIMIT_SENTENCES[limit.reason] ?? OTHER_LIMIT;
    const data =
      limit.owner === null
        ? {
            title: tUi(`${base}.title`),
            message: tUi(`${base}.message`)
          }
        : {
            title: tUiFormat(`${base}.theirTitle`, limitWords(limit)),
            message: tUiFormat(`${base}.theirMessage`, limitWords(limit))
          };
    upsertNotification({
      id,
      kind: SYNC_LIMIT_KIND,
      widgetType: 'generic',
      createdAt: shown?.createdAt ?? Date.now(),
      data
    });
  }
}

function limitWords(limit: SyncLimitReached): Record<string, string> {
  return {
    owner: limit.owner ?? '',
    folder: limit.folder_name ?? tUi('notifications.sync.limit.unnamedFolder')
  };
}

/** Drop every limit notice (the device signed out, or synced with room). */
export function clearSyncLimits(): void {
  clearNotificationsByKind(SYNC_LIMIT_KIND);
}

/**
 * Wire the Rust sync reachability signals to the notification centre.
 * Installed once from the root layout. No-op (returns a noop teardown)
 * outside Tauri, where there's no Rust sync backend to listen to.
 */
export function installSyncStatusBridge(): () => void {
  if (!isTauri()) return () => {};
  const unlistenUnreachable = listen(
    TauriEventName.SyncUnreachable,
    (payload) => {
      reportServerUnreachable(payload.server_url);
    }
  );
  const unlistenEnded = listen(TauriEventName.SessionEnded, (payload) => {
    reportSessionEnded(payload.server_url);
    // The limits were those of an account this device no longer syncs.
    clearSyncLimits();
    // The session is gone on the Rust side already. Have the UI catch up,
    // so the sign-in form shows and the sync schedule stops.
    void refreshAuthSession();
  });
  const unlistenCompleted = listen(TauriEventName.SyncCompleted, (payload) => {
    clearServerUnreachable();
    // A sync that completed means someone signed in again.
    clearSessionEnded();
    reportSyncLimits(payload.limits ?? []);
  });
  return () => {
    void unlistenUnreachable.then((unlisten) => unlisten());
    void unlistenEnded.then((unlisten) => unlisten());
    void unlistenCompleted.then((unlisten) => unlisten());
  };
}
