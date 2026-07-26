/**
 * Data + lifecycle for the `folder` and `tag` setting primitives.
 *
 * These pickers are reusable by any setting — core schema or plugin-contributed.
 * Their choices come from the live vault (folders / tags in use), and their
 * stored value auto-clears when the chosen target is deleted, so a setting can
 * never point at a folder or tag that no longer exists.
 */

import { tree } from '$lib/stores/tree.svelte';
import { allTagsInUse } from '$lib/stores/tree.svelte';
import { ALL_SETTINGS, getSettingValue, setSettingValue } from './store.svelte';
import { pluginSettingsSections } from '$lib/plugins/registry.svelte';
import type { Collection } from '$lib/api/collections';
import type { Setting } from './types';

export interface PickerItem {
  value: string;
  label: string;
}

/**
 * Every folder as `{ id, "Parent / Child" }`, sorted by path. The hierarchical
 * label disambiguates same-named folders (which a plain name never could).
 */
export function folderOptions(): PickerItem[] {
  const byId = tree.collectionsById;
  const pathOf = (id: string): string => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let current: string | null = id;
    while (current && !seen.has(current)) {
      seen.add(current);
      const folder: Collection | undefined = byId[current];
      if (!folder) break;
      parts.unshift(folder.name);
      current = folder.parent_collection_id;
    }
    return parts.join(' / ');
  };
  return Object.keys(byId)
    .map((id) => ({ value: id, label: pathOf(id) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Every tag currently in use, as picker items. */
export function tagOptions(): PickerItem[] {
  return allTagsInUse().map((tag) => ({ value: tag, label: tag }));
}

/** A setting that uses a picker primitive, with its resolved runtime id. */
interface PickerSetting {
  id: string;
  kind: 'folder' | 'tag';
}

/**
 * Every `folder`/`tag` setting across the core schema and all enabled plugins,
 * with the fully-qualified id its value is stored under.
 */
function pickerSettings(): PickerSetting[] {
  const out: PickerSetting[] = [];
  for (const setting of ALL_SETTINGS as Setting[]) {
    if (setting.type === 'folder' || setting.type === 'tag') {
      out.push({ id: setting.id, kind: setting.type });
    }
  }
  for (const { pluginId, contribution } of pluginSettingsSections()) {
    for (const setting of contribution.settings) {
      if (setting.type === 'folder' || setting.type === 'tag') {
        out.push({
          id: `plugins.${pluginId}.${setting.id}`,
          kind: setting.type
        });
      }
    }
  }
  return out;
}

/**
 * Start the app-lifetime watcher that clears any picker setting whose target no
 * longer exists — the folder was deleted, or the tag is no longer on any note.
 * Runs only once the tree has loaded, so it never clears a valid value before
 * the vault is known. Returns a stop handle (unused for the app-wide instance).
 */
export function startPickerSettingPruning(): () => void {
  return $effect.root(() => {
    $effect(() => {
      if (!tree.ready) return;
      const folders = new Set(Object.keys(tree.collectionsById));
      const tags = new Set(allTagsInUse());
      for (const { id, kind } of pickerSettings()) {
        const value = getSettingValue(id);
        if (typeof value !== 'string' || value === '') continue;
        const orphaned =
          kind === 'folder' ? !folders.has(value) : !tags.has(value);
        if (orphaned) void setSettingValue(id, '').catch(() => {});
      }
    });
  });
}
