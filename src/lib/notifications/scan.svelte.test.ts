import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  isTauri,
  isMobile,
  getSettingValue,
  checkForAvailableUpdate,
  installAvailableUpdate
} = vi.hoisted(() => ({
  isTauri: vi.fn(),
  isMobile: vi.fn(),
  getSettingValue: vi.fn(),
  checkForAvailableUpdate: vi.fn(),
  installAvailableUpdate: vi.fn()
}));

vi.mock('$lib/api/core', () => ({ isTauri }));
vi.mock('$lib/platform', () => ({ isMobile }));
vi.mock('$lib/settings/store.svelte', () => ({ getSettingValue }));
vi.mock('$lib/updater', () => ({
  checkForAvailableUpdate,
  installAvailableUpdate
}));

import { notificationState, scanForUpdateNotifications } from './store.svelte';

beforeEach(() => {
  notificationState.items = [];
  notificationState.updateScanPending = false;
  isTauri.mockReset().mockReturnValue(true);
  isMobile.mockReset().mockReturnValue(false);
  getSettingValue.mockReset().mockReturnValue(true);
  checkForAvailableUpdate.mockReset().mockResolvedValue(null);
  installAvailableUpdate.mockReset().mockResolvedValue(undefined);
});

describe('scanForUpdateNotifications (Tauri desktop)', () => {
  it('does nothing when the scan-for-updates setting is off', async () => {
    getSettingValue.mockReturnValue(false);
    await scanForUpdateNotifications(true);
    expect(checkForAvailableUpdate).not.toHaveBeenCalled();
    expect(notificationState.updateScanPending).toBe(false);
  });

  it('skips on mobile even inside Tauri', async () => {
    isMobile.mockReturnValue(true);
    await scanForUpdateNotifications(true);
    expect(checkForAvailableUpdate).not.toHaveBeenCalled();
  });

  it('clears stale update notifications when nothing is available', async () => {
    notificationState.items = [
      {
        id: 'update:old',
        kind: 'update',
        widgetType: 'update',
        createdAt: 0,
        data: {}
      }
    ];
    checkForAvailableUpdate.mockResolvedValue(null);

    await scanForUpdateNotifications(true);

    expect(notificationState.items).toHaveLength(0);
    expect(notificationState.updateScanPending).toBe(false);
  });

  it('posts an update notification whose onOpen installs the update', async () => {
    const available = {
      version: '9.9.9',
      currentVersion: '1.0.0',
      update: {}
    };
    checkForAvailableUpdate.mockResolvedValue(available);

    await scanForUpdateNotifications(true);

    expect(notificationState.items).toHaveLength(1);
    const item = notificationState.items[0];
    expect(item.id).toBe('update:9.9.9');
    expect(item.kind).toBe('update');
    expect(item.data).toMatchObject({
      version: '9.9.9',
      currentVersion: '1.0.0'
    });

    await item.onOpen?.();
    expect(installAvailableUpdate).toHaveBeenCalledWith(available);
    expect(notificationState.updateScanPending).toBe(false);
  });
});
