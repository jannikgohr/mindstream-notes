/**
 * Named sets of one plugin's setting values, to switch between. They are
 * kept beside the plugin's vault settings, under an ID no manifest can
 * declare, so they travel with the vault and no settings page lists them.
 */

import {
  getSettingValue,
  resetSettingValue,
  setSettingValue
} from '$lib/settings/store.svelte';
import { pluginSettingsSections } from './registry.svelte';
import { pluginSettingId } from './settings-store.svelte';

/** Not a slug, so it can't collide with a setting a plugin declares. */
export const PRESETS_SETTING = '$presets';

export interface SettingsPreset {
  name: string;
  /** By the plugin's own setting ID. A setting left out is at its default. */
  values: Record<string, unknown>;
}

function settingIds(pluginId: string): string[] {
  return pluginSettingsSections()
    .filter((ref) => ref.pluginId === pluginId)
    .flatMap((ref) => ref.contribution.settings.map((setting) => setting.id));
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

/** The preset the settings match right now, if any. */
export function activePreset(pluginId: string): string | undefined {
  const ids = settingIds(pluginId);
  const now = ids.map((id) =>
    JSON.stringify(getSettingValue(pluginSettingId(pluginId, id)))
  );
  return settingPresets(pluginId).find((preset) =>
    ids.every(
      (id, i) =>
        id in preset.values && JSON.stringify(preset.values[id]) === now[i]
    )
  )?.name;
}

/** Keep the settings as they are under `name`, replacing a preset so named. */
export function savePreset(pluginId: string, name: string): Promise<void> {
  const values = Object.fromEntries(
    settingIds(pluginId).map((id) => [
      id,
      getSettingValue(pluginSettingId(pluginId, id))
    ])
  );
  return store(pluginId, [
    ...settingPresets(pluginId).filter((preset) => preset.name !== name),
    { name, values }
  ]);
}

export function deletePreset(pluginId: string, name: string): Promise<void> {
  return store(
    pluginId,
    settingPresets(pluginId).filter((preset) => preset.name !== name)
  );
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
}

export async function resetSettings(pluginId: string): Promise<void> {
  await Promise.all(
    settingIds(pluginId).map((id) =>
      resetSettingValue(pluginSettingId(pluginId, id))
    )
  );
}
