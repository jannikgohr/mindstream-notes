/**
 * Keeping the diagnostics bus in step with plugin-contributed checkers.
 *
 * Plugins can be enabled, disabled, updated or removed at any time, and the
 * bus registry is imperative, so this reconciles the two: register what is
 * newly present, unregister what is gone, leave the rest alone.
 *
 * Reconciling rather than clearing and rebuilding matters because
 * unregistering a provider drops its cached findings — a rebuild on every
 * change would re-check every open note whenever any unrelated plugin
 * toggled.
 */

import { createLanguageToolProvider } from './languagetool-provider';
import { registerProvider } from './editor-diagnostics.svelte';
import { languagetoolCheck } from '$lib/api/spellcheck';
import { pluginTextCheckers } from '$lib/plugins/registry.svelte';
import { getSettingValue } from '$lib/settings/store.svelte';
import type { DiagnosticKind } from './types';

/** Registered provider id -> its unregister function. */
const active = new Map<string, () => void>();

/**
 * Plugin settings are namespaced `plugins.<pluginId>.<id>`, so a manifest
 * naming a setting is naming its own, and cannot read another plugin's or
 * the app's.
 */
function pluginSetting(
  pluginId: string,
  settingId: string
): string | undefined {
  const value = getSettingValue(`plugins.${pluginId}.${settingId}`);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Stable id for a contribution, namespaced like every other plugin id. */
export function checkerProviderId(pluginId: string, checkerId: string): string {
  return `plugins.${pluginId}.${checkerId}`;
}

/**
 * Register newly-present checkers and drop departed ones.
 *
 * Safe to call as often as plugin state changes; it is a no-op when nothing
 * has moved.
 */
export function syncPluginTextCheckers(): void {
  const contributions = pluginTextCheckers();
  const wanted = new Set<string>();

  for (const { pluginId, checker } of contributions) {
    const id = checkerProviderId(pluginId, checker.id);
    wanted.add(id);
    if (active.has(id)) continue;

    const off = registerProvider(
      createLanguageToolProvider({
        id,
        kinds: checker.kinds as DiagnosticKind[],
        config: () => {
          const endpoint = pluginSetting(pluginId, checker.endpointSetting);
          // No endpoint means the user has not configured the server yet.
          // That must read as "no opinion", not as an error on every
          // paragraph of every note.
          if (!endpoint) return null;
          return {
            endpoint,
            apiKey: checker.apiKeySetting
              ? pluginSetting(pluginId, checker.apiKeySetting)
              : undefined,
            username: checker.usernameSetting
              ? pluginSetting(pluginId, checker.usernameSetting)
              : undefined,
            // Auto-detection, matching the rest of the feature: the user
            // selects languages, they do not tag paragraphs.
            language: 'auto',
            disabledCategories: checker.disabledCategories ?? []
          };
        },
        check: languagetoolCheck
      })
    );
    active.set(id, off);
  }

  for (const [id, off] of [...active]) {
    if (wanted.has(id)) continue;
    off();
    active.delete(id);
  }
}

/** Drop every plugin checker — used when tearing down. */
export function clearPluginTextCheckers(): void {
  for (const off of active.values()) off();
  active.clear();
}
