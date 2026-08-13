import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listProfiles, setSettingsVaultId } = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  setSettingsVaultId: vi.fn()
}));
vi.mock('$lib/api/profiles', () => ({ listProfiles }));
vi.mock('$lib/settings/store.svelte', () => ({ setSettingsVaultId }));

import { currentProfile, loadProfiles, profilesState } from './profiles.svelte';

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
  profilesState.active = 'default';
  profilesState.indexActive = 'default';
  profilesState.profiles = [];
  profilesState.loaded = false;
});

describe('loadProfiles', () => {
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
