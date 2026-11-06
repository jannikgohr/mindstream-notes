/**
 * Move tree items to the trash at once, then offer Undo.
 *
 * Trashing is reversible, so a confirm dialog would make every deliberate
 * delete pay an extra click to protect the rare slip. Acting first and
 * offering a way back moves that cost onto the slip alone. Undo puts each
 * item back in the folder it came from, where "Restore" from the trash view
 * would drop it at the root. Permanent deletes (purge, empty trash) keep
 * their confirm dialogs: nothing can bring those back.
 */

import type { TreeItemRef } from '$lib/api';
import { toErrorMessage } from '$lib/api/errors';
import { tUi, tUiFormat } from '$lib/settings/i18n.svelte';
import {
  moveCollectionTo,
  moveManyTo,
  moveNoteTo,
  trashCollection,
  trashMany,
  trashNote,
  tree
} from '$lib/stores/tree.svelte';
import { pushToast } from './toast.svelte';

/** Long enough to read the toast and reach its button. */
export const TRASH_UNDO_TOAST_MS = 6000;

function parentOf(item: TreeItemRef): string | null {
  return item.kind === 'note'
    ? (tree.notesById[item.id]?.parent_collection_id ?? null)
    : (tree.collectionsById[item.id]?.parent_collection_id ?? null);
}

function nameOf(item: TreeItemRef): string {
  return item.kind === 'note'
    ? tree.notesById[item.id]?.title || tUi('fileTree.fallback.noteTitle')
    : tree.collectionsById[item.id]?.name ||
        tUi('fileTree.fallback.folderName');
}

/** Group items by the folder they sit in now, so Undo can move each group
 *  back in one batch. */
export function groupByParent(
  items: readonly TreeItemRef[],
  parent: (item: TreeItemRef) => string | null = parentOf
): Map<string | null, TreeItemRef[]> {
  const groups = new Map<string | null, TreeItemRef[]>();
  for (const item of items) {
    const key = parent(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

async function trashItems(items: readonly TreeItemRef[]): Promise<void> {
  if (items.length === 1) {
    const [item] = items;
    if (item.kind === 'note') await trashNote(item.id);
    else await trashCollection(item.id);
    return;
  }
  await trashMany([...items]);
}

async function putBack(
  groups: Map<string | null, TreeItemRef[]>
): Promise<void> {
  try {
    for (const [parent, group] of groups) {
      if (group.length === 1) {
        const [item] = group;
        if (item.kind === 'note') await moveNoteTo(item.id, parent);
        else await moveCollectionTo(item.id, parent);
      } else {
        await moveManyTo(group, parent);
      }
    }
  } catch (err) {
    console.error('[trash] undo failed', err);
    pushToast(toErrorMessage(err), { variant: 'error' });
  }
}

export async function trashWithUndo(
  items: readonly TreeItemRef[]
): Promise<void> {
  if (items.length === 0) return;
  const origins = groupByParent(items);
  const message =
    items.length === 1
      ? tUiFormat('trash.undo.movedOne', { name: nameOf(items[0]) })
      : tUiFormat('trash.undo.movedMany', { count: items.length });
  try {
    await trashItems(items);
  } catch (err) {
    console.error('[trash] move to trash failed', err);
    pushToast(toErrorMessage(err), { variant: 'error' });
    return;
  }
  pushToast(message, {
    durationMs: TRASH_UNDO_TOAST_MS,
    action: {
      label: tUi('trash.undo.action'),
      run: () => void putBack(origins)
    }
  });
}
