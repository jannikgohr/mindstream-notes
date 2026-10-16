import { afterEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args)
}));
import {
  listThemePresets,
  saveThemePreset,
  deleteThemePreset,
  getThemeAppearance
} from './theme-presets';
import { BUILTIN_PRESETS } from '$lib/settings/theme-presets';
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  localStorage.clear();
  invoke.mockReset();
});
describe('theme preset persistence bridge', () => {
  it('shares browser user presets and preserves other presets on replacement/removal', async () => {
    const custom = { ...BUILTIN_PRESETS[0], id: 'custom', name: 'Custom' };
    const second = { ...custom, id: 'second' };
    await saveThemePreset(JSON.stringify(custom));
    await saveThemePreset(JSON.stringify(second));
    await saveThemePreset(JSON.stringify({ ...custom, name: 'Revised' }));
    let presets = await listThemePresets();
    expect(presets.find((preset) => preset.id === 'custom')?.name).toBe(
      'Revised'
    );
    expect(presets).toHaveLength(5);
    await deleteThemePreset('custom');
    presets = await listThemePresets();
    expect(presets.some((preset) => preset.id === 'second')).toBe(true);
    expect(presets.some((preset) => preset.id === 'custom')).toBe(false);
  });
  it('rejects built-in replacement and malformed native palettes', async () => {
    await expect(
      saveThemePreset(JSON.stringify(BUILTIN_PRESETS[0]))
    ).rejects.toThrow();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue([
      { ...BUILTIN_PRESETS[0], light: { css: 'url(https://example.com)' } }
    ]);
    await expect(listThemePresets()).rejects.toThrow();
  });
  it('retains corrupt browser data instead of replacing it with defaults', async () => {
    localStorage.setItem('mindstream:user-theme-presets:v1', 'broken original');
    await expect(listThemePresets()).rejects.toThrow();
    const custom = { ...BUILTIN_PRESETS[0], id: 'custom' };
    await expect(saveThemePreset(JSON.stringify(custom))).rejects.toThrow();
    expect(localStorage.getItem('mindstream:user-theme-presets:v1')).toBe(
      'broken original'
    );
  });
  it('validates root appearance before using it as a new-window cache', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const value = {
      preset: BUILTIN_PRESETS[1],
      accent: '#aabbcc',
      uiFontSize: 14,
      mode: 'dark'
    };
    invoke.mockResolvedValue(value);
    expect(await getThemeAppearance()).toEqual(value);
    invoke.mockResolvedValue({ ...value, uiFontSize: 99 });
    await expect(getThemeAppearance()).rejects.toThrow();
  });
  it('falls back to the first built-in appearance outside the desktop runtime', async () => {
    await expect(getThemeAppearance()).resolves.toEqual({
      preset: BUILTIN_PRESETS[0],
      accent: null,
      uiFontSize: 16,
      mode: 'system'
    });
    expect(invoke).not.toHaveBeenCalled();
  });
  it('rejects a native catalog that repeats a preset ID', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue([BUILTIN_PRESETS[0], BUILTIN_PRESETS[0]]);
    await expect(listThemePresets()).rejects.toThrow(/Duplicate/);
  });
});
