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
import { syncNow } from '$lib/api/sync';
import { tUi } from '$lib/settings/i18n.svelte';
import { clearNotificationsByKind, upsertNotification } from './store.svelte';

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
    // The session is gone on the Rust side already. Have the UI catch up,
    // so the sign-in form shows and the sync schedule stops.
    void refreshAuthSession();
  });
  const unlistenCompleted = listen(TauriEventName.SyncCompleted, () => {
    clearServerUnreachable();
    // A sync that completed means someone signed in again.
    clearSessionEnded();
  });
  return () => {
    void unlistenUnreachable.then((unlisten) => unlisten());
    void unlistenEnded.then((unlisten) => unlisten());
    void unlistenCompleted.then((unlisten) => unlisten());
  };
}
