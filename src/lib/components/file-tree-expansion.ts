/**
 * Which folders the file tree shows open, kept per vault so that a restart
 * reopens them. Native builds keep the list in the vault's settings
 * document, beside the dock layout; browser builds keep it in the vault's
 * localStorage settings bucket. Both go through the settings store.
 */

import { getSettingValue, setSettingValue } from '$lib/settings/store.svelte';

export const EXPANDED_FOLDERS_SETTING = 'ui.expandedFolders';

/** More than any tree has open. Bounds what one save writes. */
export const MAX_EXPANDED_FOLDERS = 5000;

/** The saved folder ids. Anything that is not a list of ids reads as none. */
export function loadExpandedFolders(): string[] {
  const value = getSettingValue(EXPANDED_FOLDERS_SETTING);
  if (!Array.isArray(value)) return [];
  return value.filter(
    (id): id is string => typeof id === 'string' && id.length > 0
  );
}

/**
 * The open folders worth saving: the ones still in the tree, in a stable
 * order so that the same state writes the same value.
 */
export function expandedFoldersToSave(
  expanded: Record<string, boolean>,
  folderExists: (id: string) => boolean
): string[] {
  return Object.keys(expanded)
    .filter((id) => expanded[id] && folderExists(id))
    .sort()
    .slice(0, MAX_EXPANDED_FOLDERS);
}

export function saveExpandedFolders(ids: string[]): Promise<void> {
  return setSettingValue(EXPANDED_FOLDERS_SETTING, ids);
}
