/** Synchronous cache of backend plugin settings. Device values live at the root;
 * vault values live in the vault database. Windows refresh on plugin invalidation.
 * Browser fallback is in memory. Runtime contexts are assembled by the backend.
 */

import { isTauri } from '$lib/api/core';
import {
  pluginsSettingsAll,
  pluginsSettingsRemove,
  pluginsSettingsSet
} from '$lib/api/plugins';

/** `plugins.<pluginId>.<settingId>` → value. */
const cache = $state<{ values: Record<string, unknown> }>({ values: {} });
const revisions = new Map<string, number>();
const pending = new Map<string, number>();
const reads = new Map<string, symbol>();

function beginWrite(id: string): number {
  const revision = (revisions.get(id) ?? 0) + 1;
  revisions.set(id, revision);
  pending.set(id, (pending.get(id) ?? 0) + 1);
  return revision;
}

function endWrite(id: string): void {
  const remaining = (pending.get(id) ?? 1) - 1;
  if (remaining) pending.set(id, remaining);
  else pending.delete(id);
}

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
  const read = Symbol();
  reads.set(pluginId, read);
  const before = new Map(revisions);
  const writing = new Set(pending.keys());
  try {
    const stored = await pluginsSettingsAll(pluginId);
    if (reads.get(pluginId) !== read) return;
    const incoming = Object.fromEntries(
      Object.entries(stored).map(([key, value]) => [
        pluginSettingId(pluginId, key),
        value
      ])
    );
    for (const id of new Set([
      ...Object.keys(cache.values),
      ...Object.keys(incoming)
    ])) {
      if (parsePluginSettingId(id)?.pluginId !== pluginId) continue;
      // An invalidation can read the old document while a local edit is saving.
      // Keep that edit, including resets, until a later read can confirm it.
      if (
        writing.has(id) ||
        pending.has(id) ||
        before.get(id) !== revisions.get(id)
      )
        continue;
      if (id in incoming) cache.values[id] = incoming[id];
      else delete cache.values[id];
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
  const revision = beginWrite(id);
  try {
    await pluginsSettingsSet(parsed.pluginId, parsed.settingId, value);
  } catch (err) {
    if (revisions.get(id) === revision) {
      if (had) cache.values[id] = previous;
      else delete cache.values[id];
    }
    throw err;
  } finally {
    endWrite(id);
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
  const revision = beginWrite(id);
  try {
    await pluginsSettingsRemove(parsed.pluginId, parsed.settingId);
  } catch (err) {
    if (had && revisions.get(id) === revision) cache.values[id] = previous;
    throw err;
  } finally {
    endWrite(id);
  }
}

/** Drop all cached values. Test-only; keeps suites isolated. */
export function resetPluginSettingsCache(): void {
  cache.values = {};
  revisions.clear();
  pending.clear();
  reads.clear();
}
