/**
 * Shared reactive vault (profile) state for the top-bar switcher.
 *
 * The list of vaults and which one is active is global to the window, so
 * this module holds a single canonical reactive copy. The switcher reads
 * from it and refreshes through `loadProfiles`. Mutations (create/switch)
 * relaunch the app, so there's no optimistic in-place update to keep in
 * sync — a fresh launch re-reads the index.
 */

import { listProfiles, type Profile } from '$lib/api/profiles';

interface ProfilesState {
  active: string;
  profiles: Profile[];
  /** Has the index been read at least once? */
  loaded: boolean;
}

export const profilesState = $state<ProfilesState>({
  active: 'default',
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
      .then((view) => {
        profilesState.active = view.active;
        profilesState.profiles = view.profiles;
        profilesState.loaded = true;
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
