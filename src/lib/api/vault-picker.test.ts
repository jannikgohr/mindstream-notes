import { afterEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args)
}));
import { getVaultPickerState, openPickerVault } from './vault-picker';

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  invoke.mockReset();
});

describe('isolated picker state', () => {
  it('keeps missing vaults unavailable and reads the root language/theme', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const state = {
      vaults: [
        { id: 'missing', name: 'Missing', available: false },
        { id: 'target', name: 'Target', available: true, color: 'teal' }
      ],
      languageCode: 'de',
      themeMode: 'light'
    };
    invoke.mockResolvedValue(state);
    expect(await getVaultPickerState()).toEqual(state);
    expect(invoke).toHaveBeenCalledWith('get_picker_vaults', undefined);
  });

  it.each([
    { vaults: [], languageCode: 'de', themeMode: 'invalid' },
    { vaults: [], languageCode: null, themeMode: 'dark' },
    {
      vaults: [{ id: 'missing', name: 'Missing', available: 'true' }],
      languageCode: 'de',
      themeMode: 'dark'
    },
    {
      vaults: [{ id: 'target', name: 'Target', available: true, color: 4 }],
      languageCode: 'de',
      themeMode: 'dark'
    }
  ])(
    'rejects malformed state instead of assuming an available/default vault',
    async (state) => {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
      invoke.mockResolvedValue(state);
      await expect(getVaultPickerState()).rejects.toThrow();
    }
  );

  it('rejects a vault list that is not an array', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue({
      vaults: {},
      languageCode: 'de',
      themeMode: 'dark'
    });
    await expect(getVaultPickerState()).rejects.toThrow(/array/);
  });
});

describe('picker outside the desktop runtime', () => {
  it('shows no vaults and cannot open one', async () => {
    await expect(getVaultPickerState()).resolves.toEqual({
      vaults: [],
      languageCode: 'en',
      themeMode: 'system'
    });
    await expect(openPickerVault('target')).rejects.toThrow(/desktop runtime/);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('opening a picked vault', () => {
  it('forwards the id and expects no reply value', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValueOnce(null);
    await openPickerVault('target');
    expect(invoke).toHaveBeenCalledWith('open_picker_vault', { id: 'target' });
    invoke.mockResolvedValueOnce({ opened: true });
    await expect(openPickerVault('target')).rejects.toThrow();
  });
});
