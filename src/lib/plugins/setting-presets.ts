/**
 * Named sets of one plugin's setting values, to switch between. They are
 * kept beside the plugin's vault settings, under IDs no manifest can
 * declare, so they travel with the vault and no settings page lists them.
 */

import {
  getSettingValue,
  resetSettingValue,
  setSettingValue
} from '$lib/settings/store.svelte';
import { pluginSettingsSections } from './registry.svelte';
import { pluginSettingId } from './settings-store.svelte';

// Not slugs, so they can't collide with a setting a plugin declares.
const PRESETS_SETTING = '$presets';
const SELECTED_SETTING = '$preset';

export function isPresetSetting(settingId: string | undefined): boolean {
  return settingId === PRESETS_SETTING || settingId === SELECTED_SETTING;
}

export interface SettingsPreset {
  name: string;
  /** By the plugin's own setting ID. A setting left out is at its default. */
  values: Record<string, unknown>;
}

function settings(pluginId: string) {
  return pluginSettingsSections()
    .filter((ref) => ref.pluginId === pluginId)
    .flatMap((ref) => ref.contribution.settings);
}

function settingIds(pluginId: string): string[] {
  return settings(pluginId).map((setting) => setting.id);
}

export function settingPresets(pluginId: string): SettingsPreset[] {
  const stored = getSettingValue(pluginSettingId(pluginId, PRESETS_SETTING));
  if (!Array.isArray(stored)) return [];
  return stored.filter(
    (preset): preset is SettingsPreset =>
      !!preset &&
      typeof preset.name === 'string' &&
      !!preset.values &&
      typeof preset.values === 'object'
  );
}

function store(pluginId: string, presets: SettingsPreset[]) {
  return setSettingValue(pluginSettingId(pluginId, PRESETS_SETTING), presets);
}

function select(pluginId: string, name: string | undefined) {
  const id = pluginSettingId(pluginId, SELECTED_SETTING);
  return name === undefined ? resetSettingValue(id) : setSettingValue(id, name);
}

function matches(pluginId: string, preset: SettingsPreset): boolean {
  return settings(pluginId).every(
    ({ id, default: fallback }) =>
      JSON.stringify(id in preset.values ? preset.values[id] : fallback) ===
      JSON.stringify(getSettingValue(pluginSettingId(pluginId, id)))
  );
}

/**
 * The preset in use: the one last saved or applied, or else one the
 * settings happen to match.
 */
export function selectedPreset(pluginId: string): string | undefined {
  const presets = settingPresets(pluginId);
  const chosen = getSettingValue(pluginSettingId(pluginId, SELECTED_SETTING));
  return (
    presets.find((preset) => preset.name === chosen) ??
    presets.find((preset) => matches(pluginId, preset))
  )?.name;
}

/** The settings have moved on from the preset in use. */
export function presetChanged(pluginId: string): boolean {
  const name = selectedPreset(pluginId);
  const preset = settingPresets(pluginId).find((p) => p.name === name);
  return !!preset && !matches(pluginId, preset);
}

/**
 * Keep the settings as they are under `name`, replacing a preset so named:
 * saving under the name in use is how a preset is updated.
 */
export async function savePreset(
  pluginId: string,
  name: string
): Promise<void> {
  const values = Object.fromEntries(
    settingIds(pluginId).map((id) => [
      id,
      getSettingValue(pluginSettingId(pluginId, id))
    ])
  );
  const presets = settingPresets(pluginId);
  const at = presets.findIndex((preset) => preset.name === name);
  await store(
    pluginId,
    at < 0
      ? [...presets, { name, values }]
      : presets.map((preset, i) => (i === at ? { name, values } : preset))
  );
  await select(pluginId, name);
}

/** Give a preset another name, in place of any preset that had it. */
export async function renamePreset(
  pluginId: string,
  from: string,
  to: string
): Promise<void> {
  if (from === to) return;
  const wasSelected = selectedPreset(pluginId) === from;
  await store(
    pluginId,
    settingPresets(pluginId)
      .filter((preset) => preset.name !== to)
      .map((preset) =>
        preset.name === from ? { ...preset, name: to } : preset
      )
  );
  if (wasSelected) await select(pluginId, to);
}

/** Forget a preset. The settings stay as they are. */
export async function deletePreset(
  pluginId: string,
  name: string
): Promise<void> {
  const wasSelected = selectedPreset(pluginId) === name;
  await store(
    pluginId,
    settingPresets(pluginId).filter((preset) => preset.name !== name)
  );
  if (wasSelected) await select(pluginId, undefined);
}

/** Set every setting to the preset's value, or its default if it has none. */
export async function applyPreset(
  pluginId: string,
  name: string
): Promise<void> {
  const preset = settingPresets(pluginId).find((p) => p.name === name);
  if (!preset) return;
  await Promise.all(
    settingIds(pluginId).map((id) =>
      id in preset.values
        ? setSettingValue(pluginSettingId(pluginId, id), preset.values[id])
        : resetSettingValue(pluginSettingId(pluginId, id))
    )
  );
  await select(pluginId, name);
}

/** Put every setting back to its default, with no preset in use. */
export async function resetSettings(pluginId: string): Promise<void> {
  await Promise.all(
    settingIds(pluginId).map((id) =>
      resetSettingValue(pluginSettingId(pluginId, id))
    )
  );
  await select(pluginId, undefined);
}
