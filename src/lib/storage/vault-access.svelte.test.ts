import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VaultNotReadyError,
  assertVaultNotUnavailable,
  canWriteStorage,
  markVaultLost,
  markVaultReady,
  markVaultUnavailable,
  onVaultAccessChange,
  registerVaultAccessProbe,
  requireVaultAccess,
  resetVaultAccessForTests,
  vaultAccess
} from './vault-access.svelte';

beforeEach(() => resetVaultAccessForTests('pending'));
afterEach(() => registerVaultAccessProbe(null));

describe('requireVaultAccess', () => {
  it('waits while pending and loads the vault once for every waiting write', async () => {
    const probe = vi.fn(async () => {
      await Promise.resolve();
      markVaultReady();
    });
    registerVaultAccessProbe(probe);
    await Promise.all([
      requireVaultAccess('saving a note'),
      requireVaultAccess('saving a setting')
    ]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(canWriteStorage()).toBe(true);
  });

  it('refuses the waiting writes when loading the vault fails', async () => {
    registerVaultAccessProbe(async () =>
      markVaultUnavailable('The database is open in another tab.')
    );
    const write = requireVaultAccess('saving a setting');
    await expect(write).rejects.toBeInstanceOf(VaultNotReadyError);
    await expect(write).rejects.toMatchObject({
      code: 'vaultNotReady',
      operation: 'saving a setting',
      reason: 'The database is open in another tab.'
    });
  });

  it('refuses at once while unavailable, and lets writes through after a successful load', async () => {
    const probe = vi.fn(async () => {});
    registerVaultAccessProbe(probe);
    markVaultUnavailable('busy');
    await expect(requireVaultAccess('saving')).rejects.toBeInstanceOf(
      VaultNotReadyError
    );
    expect(probe).not.toHaveBeenCalled();
    markVaultReady();
    await expect(requireVaultAccess('saving')).resolves.toBeUndefined();
  });

  it('refuses instead of waiting forever in a window without a vault', async () => {
    await expect(requireVaultAccess('saving')).rejects.toMatchObject({
      reason: 'this window has no vault'
    });
  });

  it('keeps waiting when the load does not settle the gate, until something does', async () => {
    registerVaultAccessProbe(async () => {});
    let settled = false;
    const write = requireVaultAccess('saving').then(() => (settled = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    markVaultReady();
    await write;
    expect(settled).toBe(true);
  });
});

describe('status changes', () => {
  it('returns to pending only from ready when the connection is lost', () => {
    markVaultUnavailable('busy');
    markVaultLost();
    expect(vaultAccess.status).toBe('unavailable');
    markVaultReady();
    markVaultLost();
    expect(vaultAccess.status).toBe('pending');
  });

  it('tells listeners the status it left', () => {
    const seen: string[] = [];
    const stop = onVaultAccessChange((status, previous) =>
      seen.push(`${previous}->${status}`)
    );
    markVaultUnavailable('busy');
    markVaultUnavailable('still busy');
    markVaultReady();
    stop();
    markVaultLost();
    expect(seen).toEqual(['pending->unavailable', 'unavailable->ready']);
    expect(vaultAccess.reason).toBeNull();
  });

  it('assertVaultNotUnavailable throws only while unavailable', () => {
    expect(() => assertVaultNotUnavailable('x')).not.toThrow();
    markVaultUnavailable('busy');
    expect(() => assertVaultNotUnavailable('setting x')).toThrow(
      /setting x was not saved/
    );
  });
});
