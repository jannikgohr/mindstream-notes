import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearNotificationsByKind,
  dismissNotification,
  notificationState,
  openNotification,
  scanForUpdateNotifications,
  upsertNotification
} from './store.svelte';
import type { AppNotification, NotificationKind } from './types';

const notif = (
  id: string,
  kind: NotificationKind = 'generic',
  extra: Partial<AppNotification> = {}
): AppNotification => ({
  id,
  kind,
  widgetType: kind,
  createdAt: Date.now(),
  data: {},
  ...extra
});

beforeEach(() => {
  notificationState.items = [];
  notificationState.updateScanPending = false;
});

describe('upsertNotification', () => {
  it('prepends a new notification', () => {
    upsertNotification(notif('a'));
    upsertNotification(notif('b'));
    expect(notificationState.items.map((n) => n.id)).toEqual(['b', 'a']);
  });

  it('replaces an existing notification in place', () => {
    upsertNotification(notif('a', 'generic', { data: { v: 1 } }));
    upsertNotification(notif('a', 'generic', { data: { v: 2 } }));
    expect(notificationState.items).toHaveLength(1);
    expect(notificationState.items[0].data).toEqual({ v: 2 });
  });
});

describe('dismissNotification', () => {
  it('removes the matching notification', () => {
    upsertNotification(notif('a'));
    upsertNotification(notif('b'));
    dismissNotification('a');
    expect(notificationState.items.map((n) => n.id)).toEqual(['b']);
  });
});

describe('clearNotificationsByKind', () => {
  it('drops only notifications of the given kind', () => {
    upsertNotification(notif('u1', 'update'));
    upsertNotification(notif('g1', 'generic'));
    upsertNotification(notif('u2', 'update'));
    clearNotificationsByKind('update');
    expect(notificationState.items.map((n) => n.id)).toEqual(['g1']);
  });
});

describe('openNotification', () => {
  it('invokes the onOpen handler when present', async () => {
    const onOpen = vi.fn();
    upsertNotification(notif('a', 'generic', { onOpen }));
    await openNotification('a');
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('is a no-op for an unknown id or a handler-less notification', async () => {
    upsertNotification(notif('a'));
    await expect(openNotification('missing')).resolves.toBeUndefined();
    await expect(openNotification('a')).resolves.toBeUndefined();
  });
});

describe('scanForUpdateNotifications', () => {
  it('short-circuits outside Tauri without flipping the pending flag', async () => {
    await scanForUpdateNotifications();
    expect(notificationState.updateScanPending).toBe(false);
    expect(notificationState.items).toHaveLength(0);
  });
});
