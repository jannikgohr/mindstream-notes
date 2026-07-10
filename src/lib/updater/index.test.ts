import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  check,
  isTauri,
  isAppImageInstall,
  getPlatform,
  alert,
  confirm,
  relaunch
} = vi.hoisted(() => ({
  check: vi.fn(),
  isTauri: vi.fn(),
  isAppImageInstall: vi.fn(),
  getPlatform: vi.fn(),
  alert: vi.fn(),
  confirm: vi.fn(),
  relaunch: vi.fn()
}));

vi.mock('@tauri-apps/plugin-updater', () => ({ check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch }));
vi.mock('$lib/platform', () => ({ getPlatform }));
vi.mock('$lib/api', () => ({ isTauri, isAppImageInstall }));
vi.mock('$lib/components/confirm-dialog.svelte', () => ({ alert, confirm }));
vi.mock('$lib/settings/i18n.svelte', () => ({ tUi: (k: string) => k }));

import {
  checkForAvailableUpdate,
  checkForUpdatesInteractively,
  installAvailableUpdate,
  type AvailableUpdate
} from './index';

const fakeUpdate = (
  downloadAndInstall = vi.fn().mockResolvedValue(undefined)
) =>
  ({
    version: '2.0.0',
    downloadAndInstall
  }) as unknown as AvailableUpdate['update'];

beforeEach(() => {
  check.mockReset();
  isTauri.mockReset().mockReturnValue(true);
  isAppImageInstall.mockReset().mockResolvedValue(true);
  getPlatform.mockReset().mockReturnValue('windows');
  alert.mockReset().mockResolvedValue(undefined);
  confirm.mockReset().mockResolvedValue(false);
  relaunch.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkForAvailableUpdate', () => {
  it('returns null outside Tauri', async () => {
    isTauri.mockReturnValue(false);
    expect(await checkForAvailableUpdate()).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it('skips non-AppImage Linux installs and can alert', async () => {
    getPlatform.mockReturnValue('linux');
    isAppImageInstall.mockResolvedValue(false);
    expect(
      await checkForAvailableUpdate({ alertOnUnsupported: true })
    ).toBeNull();
    expect(alert).toHaveBeenCalledOnce();
  });

  it('returns null and can alert when the check throws', async () => {
    check.mockRejectedValue(new Error('network'));
    expect(await checkForAvailableUpdate({ alertOnError: true })).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      '[updater] check failed',
      expect.any(Error)
    );
    expect(alert).toHaveBeenCalledOnce();
  });

  it('returns null and can alert when already up to date', async () => {
    check.mockResolvedValue(null);
    expect(await checkForAvailableUpdate({ alertOnCurrent: true })).toBeNull();
    expect(alert).toHaveBeenCalledOnce();
  });

  it('returns the available update with versions', async () => {
    check.mockResolvedValue(fakeUpdate());
    const available = await checkForAvailableUpdate();
    expect(available?.version).toBe('2.0.0');
    expect(available?.currentVersion).toBeTruthy();
    expect(console.info).toHaveBeenCalledWith(
      `[updater] available: 2.0.0 (current ${available?.currentVersion})`
    );
  });
});

describe('installAvailableUpdate', () => {
  const available = (
    downloadAndInstall = vi.fn().mockResolvedValue(undefined)
  ): AvailableUpdate => ({
    update: fakeUpdate(downloadAndInstall),
    version: '2.0.0',
    currentVersion: '1.0.0'
  });

  it('does nothing when the user declines the install', async () => {
    confirm.mockResolvedValue(false);
    const dl = vi.fn();
    await installAvailableUpdate(available(dl));
    expect(dl).not.toHaveBeenCalled();
  });

  it('drives the download progress events and offers a restart', async () => {
    // confirm: 1st = install? yes, 2nd = restart? no.
    confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const dl = vi.fn(async (cb: (e: unknown) => void) => {
      cb({ event: 'Started', data: { contentLength: 100 } });
      cb({ event: 'Progress', data: { chunkLength: 40 } });
      cb({ event: 'Finished', data: {} });
    });

    await installAvailableUpdate(available(dl));

    expect(dl).toHaveBeenCalledOnce();
    expect(console.info).toHaveBeenCalledWith(
      '[updater] downloading 100 bytes'
    );
    expect(console.info).toHaveBeenCalledWith(
      '[updater] download finished, installing'
    );
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('relaunches when the user confirms the restart', async () => {
    confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    await installAvailableUpdate(available());
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it('alerts and bails when the install throws', async () => {
    confirm.mockResolvedValueOnce(true);
    const dl = vi.fn().mockRejectedValue(new Error('install failed'));
    await installAvailableUpdate(available(dl));
    expect(console.error).toHaveBeenCalledWith(
      '[updater] install failed',
      expect.any(Error)
    );
    expect(alert).toHaveBeenCalledOnce();
    expect(relaunch).not.toHaveBeenCalled();
  });
});

describe('checkForUpdatesInteractively', () => {
  it('installs when an update is available', async () => {
    check.mockResolvedValue(fakeUpdate());
    confirm.mockResolvedValue(false); // decline install → no relaunch
    await checkForUpdatesInteractively();
    expect(confirm).toHaveBeenCalled();
  });

  it('is a no-op when up to date', async () => {
    check.mockResolvedValue(null);
    await checkForUpdatesInteractively();
    expect(confirm).not.toHaveBeenCalled();
  });
});
