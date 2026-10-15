import { isTauri } from '$lib/api/core';
import { isMobile } from '$lib/platform';
import { getSettingValue } from '$lib/settings/store.svelte';
import type { AppNotification, NotificationKind } from './types';

interface NotificationState {
  items: AppNotification[];
  updateScanPending: boolean;
}

export const notificationState = $state<NotificationState>({
  items: [],
  updateScanPending: false
});

let checkedForUpdatesThisSession = false;

export function upsertNotification(notification: AppNotification): void {
  const index = notificationState.items.findIndex(
    (item) => item.id === notification.id
  );
  if (index >= 0) {
    notificationState.items[index] = notification;
    return;
  }
  notificationState.items = [notification, ...notificationState.items];
}

export function dismissNotification(id: string): void {
  notificationState.items = notificationState.items.filter(
    (item) => item.id !== id
  );
}

export function clearNotificationsByKind(kind: NotificationKind): void {
  notificationState.items = notificationState.items.filter(
    (item) => item.kind !== kind
  );
}

export async function openNotification(id: string): Promise<void> {
  const notification = notificationState.items.find((item) => item.id === id);
  if (!notification?.onOpen) return;
  await notification.onOpen();
}

export async function scanForUpdateNotifications(force = false): Promise<void> {
  if (!isTauri() || isMobile()) return;
  if (!force && checkedForUpdatesThisSession) return;
  if (getSettingValue('about.scanForUpdates') !== true) return;

  checkedForUpdatesThisSession = true;
  notificationState.updateScanPending = true;
  try {
    const { checkForAvailableUpdate, installAvailableUpdate } =
      await import('$lib/updater');
    const available = await checkForAvailableUpdate();
    if (!available) {
      clearNotificationsByKind('update');
      return;
    }

    upsertNotification({
      id: `update:${available.version}`,
      kind: 'update',
      widgetType: 'update',
      createdAt: Date.now(),
      data: {
        version: available.version,
        currentVersion: available.currentVersion
      },
      onOpen: async () => {
        await installAvailableUpdate(available);
      }
    });
  } finally {
    notificationState.updateScanPending = false;
  }
}

/**
 * Look for invitations to shared folders and show one notification for each.
 * Runs when the app starts, and again whenever the server says an invitation
 * arrived or went away.
 */
export async function scanForShareInviteNotifications(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { listIncomingShares } = await import('$lib/api/sharing');
    const shares = await listIncomingShares();

    // Keep only what still waits, so an invitation that was answered here or
    // on another device, or withdrawn by its sender, disappears.
    const waiting = new Set(
      shares.map((share) => `share-invite:${share.invitation_id}`)
    );
    notificationState.items = notificationState.items.filter(
      (item) => item.kind !== 'share-invite' || waiting.has(item.id)
    );

    for (const share of shares) {
      const id = `share-invite:${share.invitation_id}`;
      // An invitation that was listed before keeps the time it was first
      // seen. Every rescan lists it again for as long as it waits.
      const known = notificationState.items.find((item) => item.id === id);
      upsertNotification({
        id,
        kind: 'share-invite',
        widgetType: 'share-invite',
        createdAt: known?.createdAt ?? Date.now(),
        data: {
          invitationId: share.invitation_id,
          collectionUid: share.collection_uid,
          name: share.name,
          senderUsername: share.sender_username,
          accessLevel: share.access_level,
          senderKey: share.sender_key
        }
      });
    }
  } catch (err) {
    console.debug('[notifications] share invitation scan failed', err);
  }
}
