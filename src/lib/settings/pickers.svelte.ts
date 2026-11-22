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
import { TRASH_ID } from '$lib/api/index';
import { ALL_SETTINGS, getSettingValue, setSettingValue } from './store.svelte';
import { pluginSettingsSections } from '$lib/plugins/registry.svelte';
import { ancestorIsTrash } from '$lib/editor/trash';
import { folderPathLabel } from '$lib/notes/folder-path';
import { noteIsUnderTrash } from '$lib/stores/note-source.svelte';
import type { Setting } from './types';
import { tUi } from '$lib/settings/i18n.svelte';

export interface PickerItem {
  value: string;
  label: string;
  /** Where the item lives, such as "Parent / Child" for a folder. The picker
   *  shortens this before `name`, so same-named items stay distinguishable. */
  parent?: string;
  name?: string;
}

function pathItem(value: string, parent: string, name: string): PickerItem {
  return {
    value,
    label: parent ? `${parent} / ${name}` : name,
    ...(parent ? { parent, name } : {})
  };
}

/** True when `id` is the trash folder or lives anywhere under it. */
function isUnderTrash(id: string): boolean {
  return ancestorIsTrash(id, tree.collectionsById, TRASH_ID);
}

/**
 * Ids of folders a picker may select: they exist and aren't trashed. A folder
 * moved to Trash counts as deleted, so it drops out of the picker and any
 * setting pointing at it is pruned.
 */
function liveFolderIds(): Set<string> {
  return new Set(
    Object.keys(tree.collectionsById).filter((id) => !isUnderTrash(id))
  );
}

/**
 * Every live folder as `{ id, "Parent / Child" }`, sorted by path. The
 * hierarchical label disambiguates same-named folders (which a plain name never
 * could).
 */
export function folderOptions(): PickerItem[] {
  const byId = tree.collectionsById;
  return [...liveFolderIds()]
    .map((id) =>
      pathItem(
        id,
        folderPathLabel(byId[id].parent_collection_id, byId),
        byId[id].name
      )
    )
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Every note outside the trash as `{ id, "Folder / Title" }`, sorted by label. */
export function noteOptions(): PickerItem[] {
  const byId = tree.collectionsById;
  return Object.values(tree.notesById)
    .filter((note) => !noteIsUnderTrash(note, byId))
    .map((note) => {
      const title = note.title.trim() || tUi('fileTree.fallback.noteTitle');
      const folder = note.parent_collection_id
        ? folderPathLabel(note.parent_collection_id, byId)
        : '';
      return pathItem(note.id, folder, title);
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Every tag currently in use, as picker items. */
export function tagOptions(): PickerItem[] {
  return allTagsInUse().map((tag) => ({ value: tag, label: tag }));
}

/** A setting that uses a picker primitive, with its resolved runtime id. */
interface PickerSetting {
  id: string;
  kind: 'folder' | 'tag' | 'note';
}

/**
 * Every `folder`/`tag` setting across the core schema and all enabled plugins,
 * with the fully-qualified id its value is stored under.
 */
function pickerSettings(): PickerSetting[] {
  const out: PickerSetting[] = [];
  for (const setting of ALL_SETTINGS as Setting[]) {
    if (
      setting.type === 'folder' ||
      setting.type === 'tag' ||
      setting.type === 'note'
    ) {
      out.push({ id: setting.id, kind: setting.type });
    }
  }
  for (const { pluginId, contribution } of pluginSettingsSections()) {
    for (const setting of contribution.settings) {
      if (
        setting.type === 'folder' ||
        setting.type === 'tag' ||
        setting.type === 'note'
      ) {
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
 * the vault is known. A failed load also marks the tree ready, with an empty
 * or stale tree: another browser tab holding the vault, or a storage error.
 * Pruning then would erase every folder and tag setting, so it waits for a
 * load that succeeds. Returns a stop handle (unused for the app-wide instance).
 */
export function startPickerSettingPruning(): () => void {
  return $effect.root(() => {
    $effect(() => {
      if (!tree.ready || tree.error) return;
      const folders = liveFolderIds();
      const tags = new Set(allTagsInUse());
      const notes = new Set(
        Object.values(tree.notesById)
          .filter((note) => !noteIsUnderTrash(note, tree.collectionsById))
          .map((note) => note.id)
      );
      for (const { id, kind } of pickerSettings()) {
        const value = getSettingValue(id);
        if (typeof value !== 'string' || value === '') continue;
        const live =
          kind === 'folder' ? folders : kind === 'tag' ? tags : notes;
        const orphaned = !live.has(value);
        if (orphaned) void setSettingValue(id, '').catch(() => {});
      }
    });
  });
}
