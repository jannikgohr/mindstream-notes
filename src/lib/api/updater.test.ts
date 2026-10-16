import { afterEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args)
}));
import {
  checkCoordinatedUpdate,
  installCoordinatedUpdate,
  parseUpdateProgress
} from './updater';

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  invoke.mockReset();
});

describe('coordinated updates', () => {
  it('reports an unsupervised runtime without an update in the browser', async () => {
    await expect(checkCoordinatedUpdate(false)).resolves.toEqual({
      supervised: false,
      available: null
    });
    await expect(installCoordinatedUpdate('id')).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('parses the coordinator reply with and without an available update', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const available = { id: 'u1', version: '2.0.0', currentVersion: '1.0.0' };
    invoke.mockResolvedValueOnce({ supervised: true, available });
    await expect(checkCoordinatedUpdate(true)).resolves.toEqual({
      supervised: true,
      available
    });
    expect(invoke).toHaveBeenLastCalledWith('check_coordinated_update', {
      force: true
    });
    invoke.mockResolvedValueOnce({ supervised: true, available: null });
    await expect(checkCoordinatedUpdate(false)).resolves.toEqual({
      supervised: true,
      available: null
    });
  });

  it.each([
    { supervised: 'yes', available: null },
    { supervised: true, available: 'u1' },
    {
      supervised: true,
      available: { id: 'u1', version: 2, currentVersion: '1.0.0' }
    }
  ])('rejects a malformed check reply %#', async (reply) => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue(reply);
    await expect(checkCoordinatedUpdate(false)).rejects.toThrow();
  });

  it('installs one update by id and expects no reply value', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValueOnce(null);
    await installCoordinatedUpdate('u1');
    expect(invoke).toHaveBeenLastCalledWith('install_coordinated_update', {
      id: 'u1'
    });
    invoke.mockResolvedValueOnce('unexpected');
    await expect(installCoordinatedUpdate('u1')).rejects.toThrow();
  });
});

describe('update download progress', () => {
  it('accepts known and unknown totals', () => {
    expect(
      parseUpdateProgress({ downloaded: 10, total: 100, finished: false })
    ).toEqual({ downloaded: 10, total: 100, finished: false });
    expect(
      parseUpdateProgress({ downloaded: 10, total: null, finished: true })
    ).toEqual({ downloaded: 10, total: null, finished: true });
  });

  it.each([
    { downloaded: -1, total: null, finished: false },
    { downloaded: 1, total: -1, finished: false },
    { downloaded: 1, total: 'many', finished: false },
    { downloaded: 1, total: 2, finished: 'no' },
    'progress'
  ])('rejects an impossible progress report %#', (value) => {
    expect(() => parseUpdateProgress(value)).toThrow();
  });
});
