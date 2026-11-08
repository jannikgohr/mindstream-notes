import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { invokeTauri, TauriCommandName } from './core';
import {
  importProgressed,
  resetImportActivityForTests
} from '$lib/storage/import-activity.svelte';
import { resetVaultAccessForTests } from '$lib/storage/vault-access.svelte';

beforeEach(() => {
  invoke.mockReset();
  resetImportActivityForTests();
  resetVaultAccessForTests('ready');
});

describe('a write that meets an import it has not heard of', () => {
  it('waits for the import to end and goes again', async () => {
    let saves = 0;
    invoke.mockImplementation(async (command: string) => {
      if (command === 'notes_import_running') return true;
      saves += 1;
      if (saves === 1)
        throw { code: 'database', message: 'database is locked' };
      return 'saved';
    });

    const save = invokeTauri(TauriCommandName.SaveNote, { input: { id: 'n' } });
    await vi.waitFor(() => expect(saves).toBe(1));
    await Promise.resolve();
    expect(saves).toBe(1);

    importProgressed({ phase: 'finished', done: 0, total: 0 });
    await expect(save).resolves.toBe('saved');
    expect(saves).toBe(2);
  });

  it('passes a locked error on when no import runs', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'notes_import_running') return false;
      throw { code: 'database', message: 'database is locked' };
    });
    await expect(
      invokeTauri(TauriCommandName.SaveNote, { input: { id: 'n' } })
    ).rejects.toMatchObject({ message: 'database is locked' });
  });

  it('never retries a read', async () => {
    invoke.mockRejectedValue({ message: 'database is locked' });
    await expect(invokeTauri(TauriCommandName.LoadTree)).rejects.toBeDefined();
    expect(invoke).toHaveBeenCalledOnce();
  });
});
