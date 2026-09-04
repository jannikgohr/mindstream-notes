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
 * `plugins/templates/manifest.json` (repo root; bundled into the app resource
 * dir as `core-plugins/`) the app also ships as a resource — is imported
 * directly and registered as a builtin.
 *
 * Every plugin loads in isolation: a manifest that fails validation is recorded
 * as that plugin's load error and skipped, so a broken plugin can never take
 * down startup or another plugin.
 */

import { isTauri } from '$lib/api/core';
import { pluginsDiscover, type DiscoveredPluginView } from '$lib/api/plugins';
import templatesManifest from '../../../plugins/templates/manifest.json';
import { recordPluginLoadError, registerPlugin } from './registry.svelte';
import { hydratePluginSettings } from './settings-store.svelte';
import { reportGatedPlugins, type GatedPlugin } from './gate-notify';
import { SOURCE_INSTALLED } from './source';

/** Best-effort id extraction for the error path (manifest may be malformed). */
function manifestId(manifest: unknown): string {
  if (manifest && typeof manifest === 'object' && 'id' in manifest) {
    const id = (manifest as { id: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return '<unknown>';
}

/** Manifest `name`, falling back to `fallback` (for notifications). */
function manifestName(manifest: unknown, fallback: string): string {
  if (manifest && typeof manifest === 'object' && 'name' in manifest) {
    const name = (manifest as { name: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return fallback;
}

/**
 * Third-party plugins the gate disabled. A never-approved install has an empty
 * `acceptedHash` (it is `'new'`); a plugin whose manifest changed since approval
 * keeps its old accepted hash (it is `'changed'`) — the two drive different
 * notifications.
 */
function gatedFromViews(views: DiscoveredPluginView[]): GatedPlugin[] {
  return views
    .filter(
      (v) =>
        !v.record.enabled &&
        !!v.record.lastLoadError &&
        v.record.source === SOURCE_INSTALLED
    )
    .map((v) => ({
      id: v.record.id,
      name: manifestName(v.manifest, v.record.id),
      reason: v.record.acceptedHash === '' ? 'new' : 'changed'
    }));
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
    // Pull each plugin's stored settings into the cache so the first
    // synchronous read (a settings control, a `$derived`) already has the real
    // value rather than the manifest default.
    await Promise.all(
      views.map((view) => hydratePluginSettings(view.record.id))
    );
    // Surface (or clear) the "needs re-approval" notification for any
    // third-party plugin the gate disabled.
    reportGatedPlugins(gatedFromViews(views));
  } catch (err) {
    console.error('[plugins] discovery failed', err);
  }
}
