/**
 * Bridges plugin-contributed settings into the app's schema-driven settings
 * dialog without the core settings modules ever importing the plugins layer.
 *
 * Two seams do the work:
 *
 *   - {@link pluginSettingsCategory} builds a synthetic "Plugins" category (one
 *     section per contribution) that the dialog appends to the static schema
 *     categories. It returns `null` when no enabled plugin contributes settings,
 *     so the category only appears when there's something to show.
 *
 *   - {@link installPluginSettingsBridge} registers the store's dynamic setting
 *     resolver (so a plugin setting's scope + default are honoured) and the
 *     i18n label resolver (so labels/descriptions/section titles resolve through
 *     plugin i18n). Both are consulted only after the static schema/bundles miss.
 *
 * Plugin settings live under a flat `plugins.<pluginId>.<settingId>` key space;
 * the reverse indexes here map those full ids back to the owning plugin.
 */

import { registerSettingsLabelResolver } from '$lib/settings/i18n.svelte';
import { registerDynamicSettingResolver } from '$lib/settings/store.svelte';
import type { Category, Section, Setting } from '$lib/settings/types';
import { pluginSettingsSections } from './registry.svelte';
import {
  resolvePluginString,
  resolvePluginStringOptional
} from './plugin-i18n';
import type { PluginSetting, PluginSettingsContribution } from './types';

/** The synthetic category id under which all plugin settings are grouped. */
export const PLUGINS_CATEGORY_ID = 'plugins';

function fullSectionId(pluginId: string, sectionId: string): string {
  return `plugins.${pluginId}.${sectionId}`;
}
function fullSettingId(pluginId: string, settingId: string): string {
  return `plugins.${pluginId}.${settingId}`;
}

/** Convert a plugin setting into the core `Setting` shape the dialog renders. */
function toCoreSetting(pluginId: string, s: PluginSetting): Setting {
  const base: Record<string, unknown> = {
    id: fullSettingId(pluginId, s.id),
    scope: s.scope,
    type: s.type
  };
  if (s.default !== undefined) base.default = s.default;
  if (s.options) base.options = s.options;
  // Namespaced like the setting id itself, so two plugins asking for the
  // same action get their own handler bound to their own configuration.
  if (s.type === 'button' && s.actionId) {
    base.actionId = fullSettingId(pluginId, s.actionId);
  }
  return base as unknown as Setting;
}

interface SettingEntry {
  pluginId: string;
  setting: PluginSetting;
}
interface SectionEntry {
  pluginId: string;
  contribution: PluginSettingsContribution;
}

/** full setting id → owning plugin + contribution. Rebuilt per call (small). */
function settingIndex(): Map<string, SettingEntry> {
  const map = new Map<string, SettingEntry>();
  for (const { pluginId, contribution } of pluginSettingsSections()) {
    for (const setting of contribution.settings) {
      map.set(fullSettingId(pluginId, setting.id), { pluginId, setting });
    }
  }
  return map;
}

/** full section id → owning plugin + contribution. */
function sectionIndex(): Map<string, SectionEntry> {
  const map = new Map<string, SectionEntry>();
  for (const { pluginId, contribution } of pluginSettingsSections()) {
    map.set(fullSectionId(pluginId, contribution.sectionId), {
      pluginId,
      contribution
    });
  }
  return map;
}

/**
 * The synthetic "Plugins" settings category, or `null` when no enabled plugin
 * contributes any settings. Reactive: reads the live registry, so it appears /
 * updates as plugins are enabled or disabled.
 */
export function pluginSettingsCategory(): Category | null {
  const contributions = pluginSettingsSections();
  if (contributions.length === 0) return null;
  const sections: Section[] = contributions.map(
    ({ pluginId, contribution }) => ({
      id: fullSectionId(pluginId, contribution.sectionId),
      settings: contribution.settings.map((s) => toCoreSetting(pluginId, s))
    })
  );
  return { id: PLUGINS_CATEGORY_ID, icon: 'puzzle', sections };
}

/**
 * The settings sections contributed by one plugin, as core `Section`s. Empty
 * when the plugin is disabled or contributes no settings. Used by the settings
 * UI to render a single plugin's config in isolation.
 */
export function pluginSettingsSectionsFor(pluginId: string): Section[] {
  const out: Section[] = [];
  for (const { pluginId: owner, contribution } of pluginSettingsSections()) {
    if (owner !== pluginId) continue;
    out.push({
      id: fullSectionId(owner, contribution.sectionId),
      settings: contribution.settings.map((s) => toCoreSetting(owner, s))
    });
  }
  return out;
}

/** Resolve a full plugin setting id to a core `Setting`, if it exists. */
export function pluginSettingDef(id: string): Setting | undefined {
  const entry = settingIndex().get(id);
  return entry ? toCoreSetting(entry.pluginId, entry.setting) : undefined;
}

/**
 * Wire the plugin settings into the core store + i18n. Idempotent — safe to
 * call once at app startup. Passing nothing installs the live resolvers;
 * clearing is available for teardown in tests.
 */
export function installPluginSettingsBridge(): void {
  registerDynamicSettingResolver(pluginSettingDef);
  registerSettingsLabelResolver({
    label(scope, id) {
      if (scope === 'settings') {
        const entry = settingIndex().get(id);
        return entry
          ? resolvePluginString(entry.pluginId, entry.setting.labelKey)
          : undefined;
      }
      if (scope === 'sections') {
        const entry = sectionIndex().get(id);
        return entry
          ? resolvePluginString(entry.pluginId, entry.contribution.titleKey)
          : undefined;
      }
      // The "Plugins" category label comes from the core i18n bundle.
      return undefined;
    },
    description(scope, id) {
      if (scope !== 'settings') return undefined;
      const entry = settingIndex().get(id);
      return entry?.setting.descriptionKey
        ? resolvePluginStringOptional(
            entry.pluginId,
            entry.setting.descriptionKey
          )
        : undefined;
    },
    value(settingId, value) {
      const entry = settingIndex().get(settingId);
      const key = entry?.setting.optionLabelKeys?.[value];
      return key ? resolvePluginString(entry.pluginId, key) : undefined;
    }
  });
}

/** Remove the bridge's resolvers. Test-only. */
export function uninstallPluginSettingsBridge(): void {
  registerDynamicSettingResolver(null);
  registerSettingsLabelResolver(null);
}
