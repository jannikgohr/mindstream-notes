/**
 * Builds the read-only context snapshot a plugin's backend script receives as its single
 * argument (a button action or a template `render` macro).
 *
 * Assembled on the frontend, where settings + the folder tree live, so a script
 * never needs a mid-run callback into the app (the script worker has no live DB —
 * `ms.notes` metadata is added separately by the backend when `notes.read` is
 * granted). Kept in its own module so both `effects.ts` and `templates.ts` can
 * use it without an import cycle.
 */

import { getSettingValue } from '$lib/settings/store.svelte';
import { i18n } from '$lib/settings/i18n.svelte';
import { ui } from '$lib/state.svelte';
import { tree } from '$lib/stores/tree.svelte';
import { pluginById } from './registry.svelte';

/**
 * `{ settings, folders, activeNoteId, locale, now }` for `pluginId`. `settings`
 * carries the plugin's own setting values (keyed by their local id); `folders`
 * is the vault folder tree so a script can resolve "under folder X at any
 * depth" itself.
 */
export function buildPluginContext(pluginId: string): Record<string, unknown> {
  const plugin = pluginById(pluginId);
  const settings: Record<string, unknown> = {};
  for (const section of plugin?.manifest.contributes.settings ?? []) {
    for (const s of section.settings) {
      settings[s.id] = getSettingValue(`plugins.${pluginId}.${s.id}`);
    }
  }
  const folders = Object.values(tree.collectionsById).map((c) => ({
    id: c.id,
    name: c.name,
    parentId: c.parent_collection_id
  }));
  return {
    settings,
    folders,
    activeNoteId: ui.activeNoteId ?? null,
    locale: i18n.language,
    now: new Date().toISOString()
  };
}
