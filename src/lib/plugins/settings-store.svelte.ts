/**
 * Plugin settings, backed by the vault database rather than `localStorage`.
 *
 * Every other app setting lives in the WebView's `localStorage`, which is right
 * for settings the WebView is the only consumer of. Plugin settings are not
 * one of those: a scripted plugin receives them as `ctx.settings`, and the
 * backend is what decides what a plugin sees. While they sat in `localStorage`
 * the backend could not read them, so the frontend had to assemble the script
 * context and pass it down — which quietly made a UI action the only thing that
 * could ever invoke a plugin, since nothing else could build the argument.
 *
 * So the backend owns them (`src-tauri/src/plugins/settings.rs`) and this
 * module is the cache in front of it: reads stay synchronous, because the
 * settings dialog and every `$derived` chain expect that, and writes go through
 * Tauri. Outside Tauri (`vite preview`, the web build) there is no backend and
 * no persistence — the cache is all there is, which matches how plugins behave
 * there anyway.
 */

import { isTauri } from '$lib/api/core';
import {
  pluginsSettingsAll,
  pluginsSettingsRemove,
  pluginsSettingsSet
} from '$lib/api/plugins';

/** `plugins.<pluginId>.<settingId>` → value. */
const cache = $state<{ values: Record<string, unknown> }>({ values: {} });

/** The full setting id the settings store and dialog use. */
export function pluginSettingId(pluginId: string, settingId: string): string {
  return `plugins.${pluginId}.${settingId}`;
}

/**
 * Split a full id back into its parts, or `null` if it isn't a plugin setting.
 *
 * The plugin id is itself dotted, so the split is "strip the `plugins.`
 * prefix, then take the last segment as the setting id" — not a naive
 * three-way split, which would break on every real plugin id.
 */
export function parsePluginSettingId(
  id: string
): { pluginId: string; settingId: string } | null {
  if (!id.startsWith('plugins.')) return null;
  const rest = id.slice('plugins.'.length);
  const lastDot = rest.lastIndexOf('.');
  if (lastDot <= 0) return null;
  return {
    pluginId: rest.slice(0, lastDot),
    settingId: rest.slice(lastDot + 1)
  };
}

/** Cached value, or `undefined` when nothing is stored. Synchronous. */
export function pluginSettingValue(id: string): unknown {
  return cache.values[id];
}

/** True when a value is actually stored, as opposed to schema-defaulted. */
export function hasPluginSettingValue(id: string): boolean {
  return id in cache.values;
}

/**
 * Load one plugin's stored settings into the cache. Called for each registered
 * plugin at load time so the first synchronous read already has real values.
 */
export async function hydratePluginSettings(pluginId: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const stored = await pluginsSettingsAll(pluginId);
    for (const [settingId, value] of Object.entries(stored)) {
      cache.values[pluginSettingId(pluginId, settingId)] = value;
    }
  } catch (err) {
    console.warn('[plugins] failed to load settings for', pluginId, err);
  }
}

/**
 * Write a plugin setting. Updates the cache optimistically so the control moves
 * at once, then persists; a failed write rolls the cache back rather than
 * leaving the dialog showing a value that was never stored.
 */
export async function setPluginSettingValue(
  id: string,
  value: unknown
): Promise<void> {
  const parsed = parsePluginSettingId(id);
  if (!parsed) throw new Error(`not a plugin setting id: ${id}`);
  const had = id in cache.values;
  const previous = cache.values[id];
  cache.values[id] = value;
  if (!isTauri()) return;
  try {
    await pluginsSettingsSet(parsed.pluginId, parsed.settingId, value);
  } catch (err) {
    if (had) cache.values[id] = previous;
    else delete cache.values[id];
    throw err;
  }
}

/** Clear a plugin setting so it falls back to the manifest default. */
export async function resetPluginSettingValue(id: string): Promise<void> {
  const parsed = parsePluginSettingId(id);
  if (!parsed) return;
  const had = id in cache.values;
  const previous = cache.values[id];
  delete cache.values[id];
  if (!isTauri()) return;
  try {
    await pluginsSettingsRemove(parsed.pluginId, parsed.settingId);
  } catch (err) {
    if (had) cache.values[id] = previous;
    throw err;
  }
}

/** Drop all cached values. Test-only; keeps suites isolated. */
export function resetPluginSettingsCache(): void {
  cache.values = {};
}
