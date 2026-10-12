/**
 * Shared reactive vault (profile) state for the top-bar switcher.
 *
 * The list of vaults and which one is active is global to the window, so
 * this module holds a single canonical reactive copy. The switcher reads
 * from it and refreshes through `loadProfiles`. A supervised opening action
 * keeps the running vault unchanged; only the coordinator's last-used startup
 * preference may change. Direct devices retain their restart switch flow.
 */

import { listProfiles, type Profile } from '$lib/api/profiles';
import { setSettingsVaultId } from '$lib/settings/store.svelte';
import { invokeOrFallback, TauriCommandName, assertVoid } from '$lib/api/core';

interface ProfilesState {
  /** The vault loaded by this running process. */
  active: string;
  /** The vault `profiles.json` will load on the next launch. */
  indexActive: string;
  profiles: Profile[];
  /** Has the index been read at least once? */
  loaded: boolean;
}

export const profilesState = $state<ProfilesState>({
  active: 'default',
  indexActive: 'default',
  profiles: [],
  loaded: false
});

/** The currently-active vault, or `undefined` before the first load. */
export const currentProfile = () =>
  profilesState.profiles.find((p) => p.id === profilesState.active);

// Dedupes concurrent first loads.
let loadPromise: Promise<void> | null = null;

/** Read the vault index from the backend. Safe to call repeatedly. */
export async function loadProfiles(): Promise<void> {
  if (!loadPromise) {
    loadPromise = listProfiles()
      .then(async (view) => {
        await setSettingsVaultId(view.active);
        profilesState.active = view.active;
        profilesState.indexActive = view.index_active;
        profilesState.profiles = view.profiles;
        profilesState.loaded = true;
        await invokeOrFallback(
          TauriCommandName.VaultWorkerReady,
          undefined,
          () => undefined,
          (value) => assertVoid(value, 'vault worker readiness')
        );
      })
      .catch((err) => {
        console.warn('[profiles] load failed', err);
      })
      .finally(() => {
        loadPromise = null;
      });
  }
  return loadPromise;
}
