import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeOrFallback, TauriCommandName } from '$lib/api/core';
import {
  markVaultReady,
  markVaultUnavailable,
  registerVaultAccessProbe,
  resetVaultAccessForTests
} from './vault-access.svelte';
import {
  importProgressed,
  resetImportActivityForTests
} from './import-activity.svelte';

// Outside Tauri and without browser storage, commands reach the fallback, the
// path the in-memory store takes. The gate sits in front of it either way.
const fallback = vi.fn(() => 'done');
const run = (command: TauriCommandName) =>
  invokeOrFallback(command, {}, fallback, (value) => value);

beforeEach(() => {
  fallback.mockClear();
  resetVaultAccessForTests('pending');
  registerVaultAccessProbe(async () => {});
  resetImportActivityForTests();
});

describe('invokeOrFallback', () => {
  it('refuses a write while the vault is unavailable without running it', async () => {
    markVaultUnavailable('The database is open in another tab.');
    await expect(run(TauriCommandName.SaveNote)).rejects.toMatchObject({
      code: 'vaultNotReady',
      operation: 'save_note'
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('still answers reads while the vault is unavailable', async () => {
    markVaultUnavailable('busy');
    await expect(run(TauriCommandName.LoadTree)).resolves.toBe('done');
  });

  it('holds a write until a running import ends, and lets reads through', async () => {
    markVaultReady();
    importProgressed({ phase: 'importing', done: 500, total: 1200 });
    const write = run(TauriCommandName.SaveNote);
    await expect(run(TauriCommandName.LoadTree)).resolves.toBe('done');
    expect(fallback).toHaveBeenCalledOnce();

    importProgressed({ phase: 'finished', done: 0, total: 0 });
    await expect(write).resolves.toBe('done');
    expect(fallback).toHaveBeenCalledTimes(2);
  });
});
