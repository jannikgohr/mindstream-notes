import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listProfiles, setSettingsVaultId, workerReady } = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  setSettingsVaultId: vi.fn(),
  workerReady: vi.fn()
}));
vi.mock('$lib/api/profiles', () => ({ listProfiles }));
vi.mock('$lib/settings/store.svelte', () => ({ setSettingsVaultId }));
vi.mock('$lib/api/core', async (original) => ({
  ...(await original<typeof import('$lib/api/core')>()),
  invokeOrFallback: workerReady
}));

import {
  currentProfile,
  loadProfiles,
  loadProfilesAtStartup,
  profilesState
} from './profiles.svelte';

const VIEW = {
  active: 'work',
  index_active: 'home',
  profiles: [
    { id: 'work', name: 'Work', created_at: '' },
    { id: 'home', name: 'Home', created_at: '' }
  ]
};

beforeEach(() => {
  listProfiles.mockReset();
  setSettingsVaultId.mockReset();
  workerReady.mockReset().mockResolvedValue(undefined);
  profilesState.active = 'default';
  profilesState.indexActive = 'default';
  profilesState.profiles = [];
  profilesState.loaded = false;
});

describe('loadProfiles', () => {
  it('reports worker readiness only after vault settings finish initializing', async () => {
    let finishSettings: () => void = () => {};
    listProfiles.mockResolvedValue(VIEW);
    setSettingsVaultId.mockReturnValue(
      new Promise<void>((resolve) => {
        finishSettings = resolve;
      })
    );
    const loading = loadProfiles();
    await vi.waitFor(() =>
      expect(setSettingsVaultId).toHaveBeenCalledWith('work')
    );
    expect(workerReady).not.toHaveBeenCalled();
    expect(profilesState.loaded).toBe(false);
    finishSettings();
    await loading;
    expect(workerReady).toHaveBeenCalledOnce();
    expect(workerReady.mock.calls[0][0]).toBe('vault_worker_ready');
  });

  it('does not report readiness when native vault settings cannot initialize', async () => {
    listProfiles.mockResolvedValue(VIEW);
    setSettingsVaultId.mockRejectedValue(
      new Error('invalid retained settings')
    );
    await loadProfiles();
    expect(workerReady).not.toHaveBeenCalled();
    expect(profilesState.loaded).toBe(false);
  });

  it('retries a failed startup load before reporting readiness', async () => {
    listProfiles.mockResolvedValue(VIEW);
    setSettingsVaultId
      .mockRejectedValueOnce(new Error('app root is busy'))
      .mockResolvedValue(undefined);
    await loadProfilesAtStartup([0, 0]);
    expect(setSettingsVaultId).toHaveBeenCalledTimes(2);
    expect(workerReady).toHaveBeenCalledOnce();
    expect(workerReady.mock.calls[0][0]).toBe('vault_worker_ready');
    expect(profilesState.loaded).toBe(true);
  });

  it('reports a startup load that keeps failing so the worker can exit', async () => {
    listProfiles.mockResolvedValue(VIEW);
    setSettingsVaultId.mockRejectedValue(
      new Error('invalid retained settings')
    );
    await loadProfilesAtStartup([0, 0]);
    expect(setSettingsVaultId).toHaveBeenCalledTimes(3);
    expect(workerReady).toHaveBeenCalledOnce();
    expect(workerReady.mock.calls[0][0]).toBe('vault_worker_failed');
    expect(workerReady.mock.calls[0][1]).toEqual({
      message: 'invalid retained settings'
    });
    expect(profilesState.loaded).toBe(false);
  });

  it('populates the reactive state and syncs the settings vault id', async () => {
    listProfiles.mockResolvedValue(VIEW);
    await loadProfiles();
    expect(profilesState.active).toBe('work');
    expect(profilesState.indexActive).toBe('home');
    expect(profilesState.profiles).toHaveLength(2);
    expect(profilesState.loaded).toBe(true);
    expect(setSettingsVaultId).toHaveBeenCalledWith('work');
  });

  it('currentProfile resolves the active vault', async () => {
    listProfiles.mockResolvedValue(VIEW);
    await loadProfiles();
    expect(currentProfile()?.name).toBe('Work');
  });

  it('dedupes concurrent first loads into one backend call', async () => {
    let resolve: (v: typeof VIEW) => void = () => {};
    listProfiles.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    const a = loadProfiles();
    const b = loadProfiles();
    resolve(VIEW);
    await Promise.all([a, b]);
    expect(listProfiles).toHaveBeenCalledTimes(1);
  });

  it('swallows a backend failure without marking loaded', async () => {
    listProfiles.mockRejectedValue(new Error('no backend'));
    await expect(loadProfiles()).resolves.toBeUndefined();
    expect(profilesState.loaded).toBe(false);
    expect(setSettingsVaultId).not.toHaveBeenCalled();
  });
});
