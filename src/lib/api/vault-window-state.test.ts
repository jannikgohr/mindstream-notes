import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, isMobile } = vi.hoisted(() => ({
  invoke: vi.fn(),
  isMobile: vi.fn()
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('$lib/platform', () => ({ isMobile }));

import {
  getVaultWindowState,
  parseVaultWindowState
} from './vault-window-state';

beforeEach(() => {
  invoke.mockReset();
  isMobile.mockReset().mockReturnValue(false);
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: {},
    configurable: true
  });
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('vault window observations', () => {
  it('retains starting and unavailable workers alongside ready ones', async () => {
    const view = {
      supervised: true,
      vaults: [
        { vaultId: 'ready', status: 'ready' },
        { vaultId: 'starting', status: 'starting' },
        { vaultId: 'held', status: 'unavailable' }
      ]
    };
    invoke.mockResolvedValue(view);
    expect(await getVaultWindowState()).toEqual(view);
    expect(invoke).toHaveBeenCalledWith('get_vault_window_state', undefined);
  });

  it('keeps direct runtime separate from an empty supervised runtime', () => {
    expect(
      parseVaultWindowState({ supervised: false, vaults: [] }).supervised
    ).toBe(false);
    expect(
      parseVaultWindowState({ supervised: true, vaults: [] }).supervised
    ).toBe(true);
  });

  it('does not call a desktop command in mobile or browser previews', async () => {
    isMobile.mockReturnValue(true);
    expect(await getVaultWindowState()).toEqual({
      supervised: false,
      vaults: []
    });
    isMobile.mockReturnValue(false);
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    expect(await getVaultWindowState()).toEqual({
      supervised: false,
      vaults: []
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not turn a missing coordinator into a closed-vault observation', async () => {
    invoke.mockRejectedValue(new Error('coordinator unavailable'));
    await expect(getVaultWindowState()).rejects.toThrow(
      'coordinator unavailable'
    );
  });

  it.each([
    { supervised: true, vaults: [{ vaultId: 'a', status: 'unknown' }] },
    {
      supervised: true,
      vaults: [
        { vaultId: 'a', status: 'ready' },
        { vaultId: 'a', status: 'ready' }
      ]
    },
    { supervised: false, vaults: [{ vaultId: 'a', status: 'ready' }] },
    { supervised: 'false', vaults: [] },
    { supervised: true, vaults: [{ vaultId: '', status: 'ready' }] }
  ])('rejects malformed or contradictory state %j', (view) => {
    expect(() => parseVaultWindowState(view)).toThrow();
  });
});
