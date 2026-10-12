import { afterEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args)
}));
import { getVaultPickerState } from './vault-picker';

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
        { id: 'target', name: 'Target', available: true }
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
    }
  ])(
    'rejects malformed state instead of assuming an available/default vault',
    async (state) => {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
      invoke.mockResolvedValue(state);
      await expect(getVaultPickerState()).rejects.toThrow();
    }
  );
});
