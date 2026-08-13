/**
 * Localized-string resolution for plugin contributions.
 *
 * Plugins ship their strings as a per-locale map in the manifest, keyed by a
 * plugin-local key (`templates.meeting.name`). This module resolves such a key
 * against the *active* app language with a deterministic fallback chain, and
 * exposes the runtime namespace (`plugins.<pluginId>.<key>`) the rest of the
 * system uses so plugin strings can never collide with core app strings.
 *
 * Resolution order for `(pluginId, key)`:
 *   1. the plugin's bundle for the current locale, if it has the key;
 *   2. the plugin's English bundle (guaranteed present by validation);
 *   3. a safe technical label — the namespaced key itself — so a missing
 *      string degrades to something inspectable instead of throwing.
 *
 * Core app strings always win for app-owned keys because those live in an
 * entirely separate namespace (the settings i18n bundles); a plugin has no way
 * to address them.
 */

import { i18n } from '$lib/settings/i18n.svelte';
import { pluginById } from './registry.svelte';

/** The runtime i18n namespace for a plugin-local key. */
export function namespacedPluginKey(pluginId: string, key: string): string {
  return `plugins.${pluginId}.${key}`;
}

/**
 * Resolve a plugin-local i18n key to a display string for the active language.
 * Reads `i18n.language`, so a caller inside a reactive scope re-resolves when
 * the user switches languages. Falls back to the plugin's English string, then
 * to the namespaced key.
 */
export function resolvePluginString(pluginId: string, key: string): string {
  const bundle = pluginById(pluginId)?.manifest.contributes.i18n;
  if (bundle) {
    const localized = bundle[i18n.language]?.[key];
    if (typeof localized === 'string') return localized;
    const english = bundle['en']?.[key];
    if (typeof english === 'string') return english;
  }
  return namespacedPluginKey(pluginId, key);
}

/** Optional variant: `undefined` when the key resolves to nothing real. */
export function resolvePluginStringOptional(
  pluginId: string,
  key: string | undefined
): string | undefined {
  if (!key) return undefined;
  const bundle = pluginById(pluginId)?.manifest.contributes.i18n;
  const localized = bundle?.[i18n.language]?.[key];
  if (typeof localized === 'string') return localized;
  const english = bundle?.['en']?.[key];
  return typeof english === 'string' ? english : undefined;
}
