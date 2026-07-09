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

export async function scanForCollectionInviteNotifications(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { listIncomingShareBundles } = await import('$lib/api/sharing');
    const { bundles, unbundled_invitations } = await listIncomingShareBundles();

    // Manifest-backed shares surface as a single bundle notification; any
    // invitation that isn't part of a manifest scope still shows as a lone
    // collaboration-invite. Reconcile both kinds against what's live so
    // accepted/declined ones disappear.
    const liveBundleIds = new Set(
      bundles.map((bundle) => `share-bundle:${bundle.manifest_collection_uid}`)
    );
    const liveInviteIds = new Set(
      unbundled_invitations.map(
        (invitation) => `collaboration-invite:${invitation.id}`
      )
    );
    notificationState.items = notificationState.items.filter((item) => {
      if (item.kind === 'share-bundle') return liveBundleIds.has(item.id);
      if (item.kind === 'collaboration-invite')
        return liveInviteIds.has(item.id);
      return true;
    });

    for (const bundle of bundles) {
      upsertNotification({
        id: `share-bundle:${bundle.manifest_collection_uid}`,
        kind: 'share-bundle',
        widgetType: 'share-bundle',
        createdAt: Date.now(),
        data: {
          manifestCollectionUid: bundle.manifest_collection_uid,
          name: bundle.name,
          pending: bundle.pending,
          senderUsername: bundle.sender_username,
          accessLevel: bundle.access_level,
          complete: bundle.complete,
          warnings: bundle.warnings
        }
      });
    }

    for (const invitation of unbundled_invitations) {
      upsertNotification({
        id: `collaboration-invite:${invitation.id}`,
        kind: 'collaboration-invite',
        widgetType: 'collaboration-invite',
        createdAt: Date.now(),
        data: {
          invitationId: invitation.id,
          senderUsername: invitation.sender_username,
          collectionUid: invitation.collection_uid,
          accessLevel: invitation.access_level
        }
      });
    }
  } catch (err) {
    console.debug('[notifications] collection invite scan failed', err);
  }
}
