import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args)
}));

import {
  createProfile,
  deleteProfile,
  listProfiles,
  renameProfile,
  switchProfile
} from './profiles';

function setTauri(on: boolean): void {
  if (on)
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  else
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

// Outside Tauri (the vitest/jsdom env has no __TAURI_INTERNALS__), the
// invokeOrFallback bridge runs the browser fallback. These assert the
// switcher has a sane shape to render against without a backend.
describe('profiles api fallback (non-Tauri)', () => {
  it('listProfiles returns a single active default vault', async () => {
    const view = await listProfiles();
    expect(view.active).toBe('default');
    expect(view.index_active).toBe('default');
    expect(view.profiles).toHaveLength(1);
    expect(view.profiles[0].id).toBe('default');
  });

  it('createProfile echoes a trimmed local vault', async () => {
    const created = await createProfile('  Work  ');
    expect(created.name).toBe('Work');
    expect(created.id).not.toBe('');
  });

  it('renameProfile echoes the trimmed name locally', async () => {
    const renamed = await renameProfile('p1', '  Home  ');
    expect(renamed).toEqual({ id: 'p1', name: 'Home', created_at: '' });
  });

  it('switch/delete resolve without throwing', async () => {
    await expect(switchProfile('default')).resolves.toBeUndefined();
    await expect(deleteProfile('p1')).resolves.toBeUndefined();
  });
});

describe('profiles api (Tauri parse path)', () => {
  const P = { id: 'p1', name: 'Work', created_at: '2026-01-01T00:00:00Z' };
  beforeEach(() => {
    setTauri(true);
    invoke.mockReset();
  });
  afterEach(() => setTauri(false));

  it('listProfiles parses the profiles view', async () => {
    invoke.mockResolvedValue({
      active: 'p1',
      index_active: 'p1',
      profiles: [P]
    });
    const view = await listProfiles();
    expect(view.active).toBe('p1');
    expect(view.profiles[0]).toEqual(P);
  });

  it('listProfiles throws when profiles is not an array', async () => {
    invoke.mockResolvedValue({
      active: 'p1',
      index_active: 'p1',
      profiles: {}
    });
    await expect(listProfiles()).rejects.toThrow(/profiles must be an array/);
  });

  it('create/rename parse the returned profile', async () => {
    invoke.mockResolvedValue(P);
    await expect(createProfile('Work')).resolves.toEqual(P);
    await expect(renameProfile('p1', 'Work')).resolves.toEqual(P);
  });

  it('parseProfile throws on a non-string field', async () => {
    invoke.mockResolvedValue({ id: 1, name: 'x', created_at: '' });
    await expect(createProfile('x')).rejects.toThrow(/profile.id/);
  });

  it('switch/delete validate a void response', async () => {
    invoke.mockResolvedValueOnce(undefined);
    await expect(switchProfile('p1')).resolves.toBeUndefined();
    invoke.mockResolvedValueOnce('oops');
    await expect(deleteProfile('p1')).rejects.toThrow(
      /must not return a value/
    );
  });
});
