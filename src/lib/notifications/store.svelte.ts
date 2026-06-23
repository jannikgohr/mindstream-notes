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
