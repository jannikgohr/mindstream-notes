import { assertVoid, invokeOrFallback, TauriCommandName } from './core';
import {
  BUILTIN_PRESETS,
  parseThemePreset,
  validPresetId,
  type ThemePreset
} from '$lib/settings/theme-presets';
import { isDesktopThemeMode, DesktopThemeMode } from './desktop-settings';
const STORAGE_KEY = 'mindstream:user-theme-presets:v1';
export interface ThemeAppearance {
  preset: ThemePreset;
  uiFontSize: number;
  mode: DesktopThemeMode;
}
export function getThemeAppearance(): Promise<ThemeAppearance> {
  return invokeOrFallback(
    TauriCommandName.GetThemeAppearance,
    undefined,
    () => ({
      preset: BUILTIN_PRESETS[0],
      uiFontSize: 16,
      mode: DesktopThemeMode.System
    }),
    (value) => {
      if (!value || typeof value !== 'object')
        throw new Error('Invalid theme appearance');
      const raw = value as Record<string, unknown>;
      if (
        typeof raw.uiFontSize !== 'number' ||
        raw.uiFontSize < 12 ||
        raw.uiFontSize > 18 ||
        !Number.isFinite(raw.uiFontSize)
      )
        throw new Error('Invalid UI font size');
      const mode =
        raw.mode ?? localStorage.getItem('mode-watcher-mode') ?? 'system';
      if (!isDesktopThemeMode(mode)) throw new Error('Invalid theme mode');
      return {
        preset: parseThemePreset(raw.preset),
        uiFontSize: raw.uiFontSize,
        mode
      };
    }
  );
}
function browserPresets(): ThemePreset[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values) || values.length > 64)
    throw new Error('Invalid stored theme presets; original data retained');
  const presets = values.map(parseThemePreset);
  if (
    new Set(presets.map((preset) => preset.id)).size !== presets.length ||
    presets.some((preset) =>
      BUILTIN_PRESETS.some((builtin) => builtin.id === preset.id)
    )
  )
    throw new Error('Invalid stored preset IDs; original data retained');
  return presets;
}
export function listThemePresets(): Promise<ThemePreset[]> {
  return invokeOrFallback(
    TauriCommandName.ListThemePresets,
    undefined,
    () => [...BUILTIN_PRESETS, ...browserPresets()],
    (value) => {
      if (!Array.isArray(value) || value.length > 67)
        throw new Error('Invalid theme preset catalog');
      const presets = value.map(parseThemePreset);
      if (new Set(presets.map((preset) => preset.id)).size !== presets.length)
        throw new Error('Duplicate theme preset IDs');
      return presets;
    }
  );
}
export function saveThemePreset(raw: string): Promise<void> {
  if (new TextEncoder().encode(raw).length > 16384)
    return Promise.reject(new Error('Theme preset is too large'));
  const preset = parseThemePreset(JSON.parse(raw));
  if (BUILTIN_PRESETS.some((builtin) => builtin.id === preset.id))
    return Promise.reject(new Error('Choose a new ID for a custom preset'));
  return invokeOrFallback(
    TauriCommandName.SaveThemePreset,
    { raw },
    () => {
      const presets = browserPresets().filter(
        (previous) => previous.id !== preset.id
      );
      presets.push(preset);
      if (presets.length > 64) throw new Error('Too many theme presets');
      localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
      window.dispatchEvent(new Event('theme-presets-changed'));
    },
    (value) => assertVoid(value, 'save_theme_preset')
  );
}
export function deleteThemePreset(id: string): Promise<void> {
  if (!validPresetId(id) || BUILTIN_PRESETS.some((preset) => preset.id === id))
    return Promise.reject(new Error('Only custom presets can be removed'));
  return invokeOrFallback(
    TauriCommandName.DeleteThemePreset,
    { id },
    () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(browserPresets().filter((preset) => preset.id !== id))
      );
      window.dispatchEvent(new Event('theme-presets-changed'));
    },
    (value) => assertVoid(value, 'delete_theme_preset')
  );
}
