/**
 * Plugin management view-model, shared by the desktop + mobile settings UIs.
 *
 * The management overview lists *every* installed plugin — core and
 * third-party, enabled and disabled — so a disabled plugin stays reachable to
 * turn back on. It merges two sources:
 *   - the frontend registry ({@link allPlugins}) for name/version/enabled/
 *     contributions and any frontend load error, and
 *   - the backend records ({@link pluginsList}) for the durable `source` and
 *     `lastLoadError` (integrity gate). Backend is Tauri-only; in the browser
 *     the overview is registry-only and enable/disable is in-memory.
 *
 * Enable/disable is optimistic + reactive: it flips the registry immediately
 * (so the plugin's settings, create-menu templates and hotkeys appear/vanish
 * live) and persists to the backend when available.
 */

import { isTauri } from '$lib/api/core';
import {
  pluginsApprove,
  pluginsDisable,
  pluginsEnable,
  pluginsList,
  type PluginRecord
} from '$lib/api/plugins';
import { loadPlugins } from './load';
import { SOURCE_BUILTIN } from './source';
import {
  allPlugins,
  pluginLoadError,
  setPluginEnabled
} from './registry.svelte';
import { resolvePluginStringOptional } from './plugin-i18n';

/** One row of the management overview. */
export interface PluginOverviewEntry {
  id: string;
  name: string;
  version: string;
  /** `'builtin'` or `'installed'`. */
  source: string;
  enabled: boolean;
  /** Localized one-line description (from the manifest's descriptionKey), or null. */
  description: string | null;
  /** Why the plugin isn't contributing, if anything (bad manifest, integrity). */
  loadError: string | null;
  /** Signature verification result: `'unsigned' | 'valid' | 'invalid'`. */
  signatureStatus: string;
  /** SHA-256 fingerprint of the signer's key when signed + valid. */
  signer: string | null;
  hasSettings: boolean;
  permissions: string[];
}

const adminState = $state<{ records: Record<string, PluginRecord> }>({
  records: {}
});

/** Pull the durable backend records into the reactive cache (Tauri only). */
export async function refreshPluginAdmin(): Promise<void> {
  if (!isTauri()) return;
  try {
    const records = await pluginsList();
    const map: Record<string, PluginRecord> = {};
    for (const record of records) map[record.id] = record;
    adminState.records = map;
  } catch (err) {
    console.error('[plugins] failed to list backend records', err);
  }
}

/** Every installed plugin, enriched with backend metadata when present. */
export function pluginOverview(): PluginOverviewEntry[] {
  return allPlugins().map(({ manifest, enabled }) => {
    const record = adminState.records[manifest.id];
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      source: record?.source ?? SOURCE_BUILTIN,
      enabled,
      description:
        resolvePluginStringOptional(manifest.id, manifest.descriptionKey) ??
        null,
      loadError: pluginLoadError(manifest.id) ?? record?.lastLoadError ?? null,
      signatureStatus: record?.signatureStatus ?? 'unsigned',
      signer: record?.signer ?? null,
      hasSettings: (manifest.contributes.settings ?? []).length > 0,
      permissions: manifest.permissions
    };
  });
}

/** Enabled plugins that contribute settings — the settings-rail children. */
export function pluginsWithSettings(): { id: string; name: string }[] {
  return allPlugins()
    .filter(
      (p) => p.enabled && (p.manifest.contributes.settings ?? []).length > 0
    )
    .map((p) => ({ id: p.manifest.id, name: p.manifest.name }));
}

/**
 * Toggle a plugin on/off. Flips the reactive registry immediately, then
 * persists to the backend (best-effort; a no-op / thrown fallback outside
 * Tauri is swallowed so the in-memory state still applies).
 */
export async function setPluginEnabledAdmin(
  id: string,
  enabled: boolean
): Promise<void> {
  setPluginEnabled(id, enabled);
  if (!isTauri()) return;
  try {
    const record = enabled ? await pluginsEnable(id) : await pluginsDisable(id);
    setPluginEnabled(id, record.enabled);
  } catch (err) {
    console.error('[plugins] failed to persist enable/disable', id, err);
  }
}

/**
 * Re-approve a gated plugin: the backend accepts its current on-disk manifest
 * (hash + signer), then we re-discover so it registers + enables and the gate
 * notification refreshes.
 */
export async function approvePluginAdmin(id: string): Promise<void> {
  try {
    await pluginsApprove(id);
  } catch (err) {
    console.error('[plugins] failed to approve plugin', id, err);
    return;
  }
  await loadPlugins();
  await refreshPluginAdmin();
}
