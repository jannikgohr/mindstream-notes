/**
 * Plugin loading bootstrap.
 *
 * In the app (Tauri), plugins are discovered from disk by the backend
 * (`plugins_discover`): bundled core plugins from the app resource dir and
 * third-party plugins from the profile's app-data dir. The backend assigns each
 * plugin's trust `source` from its load location and applies the integrity gate,
 * then hands back the reconciled record + parsed manifest. This module registers
 * the contributions of the enabled ones into the reactive registry.
 *
 * Outside Tauri (`vite preview` / web-mobile) there is no backend and no disk
 * discovery, so the bundled core plugin's manifest — the single canonical
 * `core-plugins/templates/manifest.json` the app also ships as a resource — is
 * imported directly and registered as a builtin.
 *
 * Every plugin loads in isolation: a manifest that fails validation is recorded
 * as that plugin's load error and skipped, so a broken plugin can never take
 * down startup or another plugin.
 */

import { isTauri } from '$lib/api/core';
import { pluginsDiscover, type DiscoveredPluginView } from '$lib/api/plugins';
import templatesManifest from '../../../src-tauri/core-plugins/templates/manifest.json';
import { recordPluginLoadError, registerPlugin } from './registry.svelte';

/** Best-effort id extraction for the error path (manifest may be malformed). */
function manifestId(manifest: unknown): string {
  if (manifest && typeof manifest === 'object' && 'id' in manifest) {
    const id = (manifest as { id: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return '<unknown>';
}

/**
 * Register one discovered plugin. Registers with the backend's authoritative
 * `enabled` flag so disabled plugins stay in the registry (visible in the
 * management overview to re-enable) while contributing nothing. A backend load
 * error (e.g. the integrity gate) is surfaced; a manifest that fails frontend
 * validation is recorded and skipped.
 */
function applyDiscovered(view: DiscoveredPluginView): void {
  const { record, manifest } = view;
  try {
    registerPlugin(manifest, { enabled: record.enabled });
    if (record.lastLoadError)
      recordPluginLoadError(record.id, record.lastLoadError);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordPluginLoadError(record.id ?? manifestId(manifest), message);
    console.error('[plugins] failed to register plugin', record.id, err);
  }
}

/**
 * Load all plugins. Idempotent — re-running replaces existing registrations, so
 * it is safe to call again after a profile switch.
 */
export async function loadPlugins(): Promise<void> {
  if (!isTauri()) {
    // No backend discovery available: register the bundled core plugin so the
    // example is present in the web build.
    try {
      registerPlugin(templatesManifest, { enabled: true });
    } catch (err) {
      recordPluginLoadError(
        manifestId(templatesManifest),
        err instanceof Error ? err.message : String(err)
      );
    }
    return;
  }
  try {
    const views = await pluginsDiscover();
    for (const view of views) applyDiscovered(view);
  } catch (err) {
    console.error('[plugins] discovery failed', err);
  }
}
