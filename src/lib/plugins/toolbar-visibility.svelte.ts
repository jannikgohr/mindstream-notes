import { tree } from '$lib/stores/tree.svelte';
import {
  collectionIsUnder,
  noteIsUnderTrash
} from '$lib/stores/note-source.svelte';
import { pluginById, pluginToolbarButtons } from './registry.svelte';
import { getSettingValue } from '$lib/settings/store.svelte';
import { pluginSettingId } from './settings-store.svelte';
import type { PluginToolbarButton, PluginToolbarLocation } from './types';

/** UI hint only. Backend permissions and current note state still govern execution. */
export function pluginToolbarButtonIsVisible(
  pluginId: string,
  button: PluginToolbarButton
): boolean {
  const condition = button.visibleWhen;
  if (!condition) return true;
  const plugin = pluginById(pluginId);
  if (!plugin?.granted.includes('notes.read') || !tree.ready || tree.error)
    return false;
  function source(id: string | undefined): string | undefined {
    if (!id) return undefined;
    // The core store falls back to the manifest default for an unset value.
    const value = getSettingValue(pluginSettingId(pluginId, id));
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
  const folder = source(condition.folderSetting);
  const tag = source(condition.tagSetting);
  if (!folder && !tag) return false;
  return Object.values(tree.notesById).some(
    (note) =>
      !noteIsUnderTrash(note, tree.collectionsById) &&
      ((tag !== undefined && note.tags.includes(tag)) ||
        (folder !== undefined &&
          collectionIsUnder(
            note.parent_collection_id,
            folder,
            tree.collectionsById
          )))
  );
}

/** Reactive view for desktop/mobile toolbars and menus, using existing metadata only. */
export function visiblePluginToolbarButtons(
  location: PluginToolbarLocation,
  opts: { noteKind?: string | null } = {}
) {
  return pluginToolbarButtons(location, opts).filter(({ pluginId, button }) =>
    pluginToolbarButtonIsVisible(pluginId, button)
  );
}
