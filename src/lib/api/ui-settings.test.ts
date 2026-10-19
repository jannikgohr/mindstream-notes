import { afterEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args)
}));
import {
  initializeUiSettings,
  loadUiSettings,
  patchUiSetting
} from './ui-settings';

const snapshot = {
  deviceRevision: 3,
  vaultRevision: 7,
  values: { 'appearance.uiFontSize': 14 }
};

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  invoke.mockReset();
});

describe('UI settings documents', () => {
  it('require native storage instead of inventing browser defaults', async () => {
    await expect(loadUiSettings('default')).rejects.toThrow(/native storage/);
    await expect(patchUiSetting('default', 'id', 1)).rejects.toThrow(
      /native storage/
    );
    await expect(
      initializeUiSettings('default', null, null, null, null, {
        toolbarRaw: null,
        hadExistingData: false,
        displayModeRaw: null
      })
    ).rejects.toThrow(/native storage/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('hands every browser source to the one-time native initialization', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue(snapshot);
    const deviceUi = {
      toolbarRaw: '{"toolbar":[]}',
      hadExistingData: true,
      displayModeRaw: 'grid'
    };
    await expect(
      initializeUiSettings('default', '{}', '{"a":1}', 'p', 'l', deviceUi)
    ).resolves.toEqual(snapshot);
    expect(invoke).toHaveBeenCalledWith('initialize_ui_settings', {
      expectedVaultId: 'default',
      deviceRaw: '{}',
      vaultRaw: '{"a":1}',
      preferencesRaw: 'p',
      layoutRaw: 'l',
      deviceUi
    });
    await expect(loadUiSettings('default')).resolves.toEqual(snapshot);
    expect(invoke).toHaveBeenLastCalledWith('load_ui_settings', {
      expectedVaultId: 'default'
    });
  });

  it('sends removals as an explicit null value', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue(snapshot);
    await patchUiSetting('default', 'appearance.uiFontSize', 15);
    expect(invoke).toHaveBeenLastCalledWith('patch_ui_setting', {
      expectedVaultId: 'default',
      id: 'appearance.uiFontSize',
      value: 15,
      remove: false
    });
    await patchUiSetting('default', 'appearance.uiFontSize', 15, true);
    expect(invoke).toHaveBeenLastCalledWith('patch_ui_setting', {
      expectedVaultId: 'default',
      id: 'appearance.uiFontSize',
      value: null,
      remove: true
    });
  });

  it.each([
    null,
    { ...snapshot, deviceRevision: '3' },
    { ...snapshot, vaultRevision: Number.NaN },
    { ...snapshot, values: [] }
  ])('rejects a malformed snapshot %#', async (reply) => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue(reply);
    await expect(loadUiSettings('default')).rejects.toThrow();
  });
});
