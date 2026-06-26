import { describe, expect, it } from 'vitest';
import { listProfiles, createProfile, switchProfile } from './profiles';

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

  it('switchProfile resolves without throwing', async () => {
    await expect(switchProfile('default')).resolves.toBeUndefined();
  });
});
