import {
  assertRecord,
  assertString,
  assertVoid,
  TauriCommandName,
  invokeOrFallback
} from './core';

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

/** Mirrors `profiles::ProfilesView` — the list plus live and persisted active ids. */
export interface ProfilesView {
  active: string;
  index_active: string;
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
    index_active: 'default',
    profiles: [{ id: 'default', name: 'Default', created_at: '' }]
  };
}

export function listProfiles(): Promise<ProfilesView> {
  return invokeOrFallback<ProfilesView>(
    TauriCommandName.ListProfiles,
    undefined,
    fallbackView,
    parseProfilesView
  );
}

export function createProfile(name: string): Promise<Profile> {
  return invokeOrFallback<Profile>(
    TauriCommandName.CreateProfile,
    { name },
    () => ({
      id: `local-${Date.now()}`,
      name: name.trim(),
      created_at: ''
    }),
    parseProfile
  );
}

export function switchProfile(id: string): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.SwitchProfile,
    { id },
    () => undefined,
    (value) => assertVoid(value, 'switch_profile response')
  );
}

export function renameProfile(id: string, name: string): Promise<Profile> {
  return invokeOrFallback<Profile>(
    TauriCommandName.RenameProfile,
    { id, name },
    () => ({
      id,
      name: name.trim(),
      created_at: ''
    }),
    parseProfile
  );
}

export function deleteProfile(id: string): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.DeleteProfile,
    { id },
    () => undefined,
    (value) => assertVoid(value, 'delete_profile response')
  );
}

function parseProfile(value: unknown): Profile {
  const raw = assertRecord(value, 'profile');
  return {
    id: assertString(raw.id, 'profile.id'),
    name: assertString(raw.name, 'profile.name'),
    created_at: assertString(raw.created_at, 'profile.created_at')
  };
}

function parseProfiles(value: unknown): Profile[] {
  if (!Array.isArray(value)) throw new Error('profiles must be an array');
  return value.map(parseProfile);
}

function parseProfilesView(value: unknown): ProfilesView {
  const raw = assertRecord(value, 'profiles view');
  return {
    active: assertString(raw.active, 'profiles view.active'),
    index_active: assertString(raw.index_active, 'profiles view.index_active'),
    profiles: parseProfiles(raw.profiles)
  };
}
