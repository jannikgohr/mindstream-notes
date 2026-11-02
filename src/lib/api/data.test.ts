import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupNow, importBegin, importRestore } from './data';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args)
}));
const browser = vi.hoisted(() => ({
  enabled: false,
  backup: vi.fn(),
  download: vi.fn()
}));
vi.mock('../browser/commands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../browser/commands')>()),
  browserStorageEnabled: () => browser.enabled
}));
vi.mock('../browser/vault', () => ({ backupBrowserVault: browser.backup }));
vi.mock('./file-export', () => ({ downloadBlob: browser.download }));
const preview = {
  token: 'test-token',
  backup_counts: { notes: 1, folders: 2, assets_bytes: 3 },
  current_counts: { notes: 0, folders: 0, assets_bytes: 0 },
  backup_app_version: '1',
  backup_created_at: '2026-10-13',
  same_account: false,
  backup_account: null,
  current_account: null
};
beforeEach(() => {
  invoke.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
describe('browser backup', () => {
  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    browser.enabled = true;
    browser.backup.mockReset();
    browser.download.mockReset();
  });
  afterEach(() => {
    browser.enabled = false;
  });

  it('downloads the archive and reports no path', async () => {
    const archive = new Blob(['zip']);
    const counts = { notes: 1, folders: 2, assets_bytes: 3 };
    browser.backup.mockResolvedValue({
      archive,
      filename: 'mindstream-backup.zip',
      counts,
      accountPresent: false
    });
    expect(await backupNow()).toEqual({
      destination: null,
      counts,
      account_present: false
    });
    expect(browser.download).toHaveBeenCalledWith(
      archive,
      'mindstream-backup.zip'
    );
  });

  it('downloads nothing when the backup fails', async () => {
    browser.backup.mockRejectedValue(new Error('too large'));
    await expect(backupNow()).rejects.toThrow('too large');
    expect(browser.download).not.toHaveBeenCalled();
  });

  it('stays quiet in the in-memory fixture build', async () => {
    browser.enabled = false;
    expect(await backupNow()).toBeNull();
    expect(browser.backup).not.toHaveBeenCalled();
  });
});

describe('backup portability bridge', () => {
  it('reads legacy previews without inventing portable content', async () => {
    invoke.mockResolvedValue(preview);
    expect(await importBegin()).toMatchObject({
      portable: false,
      plugin_packages: 0,
      plugin_data_bytes: 0
    });
  });
  it('reads portable preview counts and rejects malformed flags', async () => {
    invoke.mockResolvedValue({
      ...preview,
      portable: true,
      plugin_packages: 4,
      plugin_data_bytes: 123
    });
    expect(await importBegin()).toMatchObject({
      portable: true,
      plugin_packages: 4,
      plugin_data_bytes: 123
    });
    invoke.mockResolvedValue({ ...preview, portable: 'true' });
    await expect(importBegin()).rejects.toThrow();
  });
  it('keeps shared import opt-in and sends the explicit choice', async () => {
    invoke.mockResolvedValue({ restart_required: true, sanitized: true });
    await importRestore('token', false);
    expect(invoke).toHaveBeenLastCalledWith('import_restore', {
      token: 'token',
      sameAccount: false,
      includeDevice: false
    });
    await importRestore('token', false, true);
    expect(invoke).toHaveBeenLastCalledWith('import_restore', {
      token: 'token',
      sameAccount: false,
      includeDevice: true
    });
  });
});
