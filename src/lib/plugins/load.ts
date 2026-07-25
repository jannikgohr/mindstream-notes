/**
 * Plugin loading bootstrap.
 *
 * Registers the bundled first-party plugins at app startup. Every plugin is
 * loaded in isolation: a manifest that fails validation is recorded as that
 * plugin's load error and skipped, so a broken plugin can never take down
 * startup or another plugin (a core plan requirement).
 *
 * Enablement is decided by an injected predicate. In the running app that reads
 * a per-plugin device setting (`plugins.<id>.enabled`, default on); tests pass
 * their own predicate to stay decoupled from the settings runtime.
 */

import { getSettingValue } from '$lib/settings/store.svelte';
import { BUILTIN_PLUGIN_MANIFESTS } from './builtin';
import { recordPluginLoadError, registerPlugin } from './registry.svelte';
import type { PluginManifest } from './types';

/** Settings key holding a plugin's enabled flag. Absent/unset ⇒ enabled. */
export function pluginEnabledSettingId(pluginId: string): string {
  return `plugins.${pluginId}.enabled`;
}

/** Default enablement: on unless the user explicitly turned the plugin off. */
export function pluginEnabledByDefault(pluginId: string): boolean {
  return getSettingValue(pluginEnabledSettingId(pluginId)) !== false;
}

/** Best-effort id extraction for the error path (manifest may be malformed). */
function manifestId(manifest: unknown): string {
  if (manifest && typeof manifest === 'object' && 'id' in manifest) {
    const id = (manifest as { id: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return '<unknown>';
}

/**
 * Register every bundled plugin. Idempotent — re-running replaces existing
 * registrations, so it is safe to call again after settings change.
 */
export function loadBuiltinPlugins(
  isEnabled: (pluginId: string) => boolean = pluginEnabledByDefault,
  manifests: readonly PluginManifest[] = BUILTIN_PLUGIN_MANIFESTS
): void {
  for (const manifest of manifests) {
    try {
      registerPlugin(manifest, { enabled: isEnabled(manifest.id) });
    } catch (err) {
      const id = manifestId(manifest);
      const message = err instanceof Error ? err.message : String(err);
      recordPluginLoadError(id, message);
      console.error('[plugins] failed to load builtin plugin', id, err);
    }
  }
}
