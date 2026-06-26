import { invokeOrFallback } from './core';

/**
 * A user vault (called a "profile" in the Rust layer). Each vault is a
 * self-contained data directory with its own notes DB, sync session and
 * settings. Mirrors `profiles::Profile` in src-tauri.
 */
export interface Profile {
  id: string;
  name: string;
  created_at: string;
}

/** Mirrors `profiles::ProfilesView` — the list plus the live active id. */
export interface ProfilesView {
  active: string;
  profiles: Profile[];
}

/**
 * The browser/mock fallback (running `pnpm dev` outside Tauri): a single
 * "Default" vault that is always active, so the switcher renders without a
 * backend.
 */
function fallbackView(): ProfilesView {
  return {
    active: 'default',
    profiles: [{ id: 'default', name: 'Default', created_at: '' }]
  };
}

export function listProfiles(): Promise<ProfilesView> {
  return invokeOrFallback<ProfilesView>(
    'list_profiles',
    undefined,
    fallbackView
  );
}

export function createProfile(name: string): Promise<Profile> {
  return invokeOrFallback<Profile>('create_profile', { name }, () => ({
    id: `local-${Date.now()}`,
    name: name.trim(),
    created_at: ''
  }));
}

export function switchProfile(id: string): Promise<void> {
  return invokeOrFallback<void>('switch_profile', { id }, () => undefined);
}

export function renameProfile(id: string, name: string): Promise<Profile> {
  return invokeOrFallback<Profile>('rename_profile', { id, name }, () => ({
    id,
    name: name.trim(),
    created_at: ''
  }));
}

export function deleteProfile(id: string): Promise<void> {
  return invokeOrFallback<void>('delete_profile', { id }, () => undefined);
}
