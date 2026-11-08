/**
 * Move tree items to the trash at once, then offer Undo.
 *
 * Trashing is reversible, so a confirm dialog would make every deliberate
 * delete pay an extra click to protect the rare slip. Acting first and
 * offering a way back moves that cost onto the slip alone. Undo puts each
 * item back in the folder it came from, where "Restore" from the trash view
 * would drop it at the root. Permanent deletes (purge, empty trash) keep
 * their confirm dialogs: nothing can bring those back.
 *
 * Undo stays on screen for a few seconds, and the tree can change in that
 * time. It only moves items this trash action still accounts for, and a
 * folder that has since been trashed or deleted sends them to the root.
 */

import { TRASH_ID, type TreeItemRef } from '$lib/api';
import { toErrorMessage } from '$lib/api/errors';
import { ancestorIsTrash } from '$lib/editor/trash';
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

/** The newest trash action for each item, so an older toast's Undo cannot
 *  overrule a later move or trash of the same item. */
const latestTrash = new Map<string, number>();
let trashActions = 0;

function itemKey(item: TreeItemRef): string {
  return `${item.kind}:${item.id}`;
}

/** Still in the trash where `action` put it, and not trashed again since. */
function stillTrashedBy(item: TreeItemRef, action: number): boolean {
  return (
    latestTrash.get(itemKey(item)) === action && parentOf(item) === TRASH_ID
  );
}

/** The folder to put items back in: where they came from, unless that
 *  folder has been deleted or is in the trash itself. */
function undoTarget(parent: string | null): string | null {
  if (parent === null || !tree.collectionsById[parent]) return null;
  return ancestorIsTrash(parent, tree.collectionsById, TRASH_ID)
    ? null
    : parent;
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
  groups: Map<string | null, TreeItemRef[]>,
  action: number
): Promise<void> {
  // Settled before anything moves: a folder put back first would otherwise
  // read as a usable target for the groups after it, or the reverse.
  const moves = [...groups].map(
    ([parent, group]) =>
      [
        undoTarget(parent),
        group.filter((item) => stillTrashedBy(item, action))
      ] as const
  );
  let failure: unknown = null;
  for (const [parent, group] of moves) {
    try {
      if (group.length === 1) {
        const [item] = group;
        if (item.kind === 'note') await moveNoteTo(item.id, parent);
        else await moveCollectionTo(item.id, parent);
      } else if (group.length > 1) {
        await moveManyTo(group, parent);
      }
    } catch (err) {
      // One group failing must not strand the others in the trash.
      console.error('[trash] undo failed', err);
      failure ??= err;
    }
  }
  if (failure) pushToast(toErrorMessage(failure), { variant: 'error' });
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
  const action = ++trashActions;
  for (const item of items) latestTrash.set(itemKey(item), action);
  pushToast(message, {
    durationMs: TRASH_UNDO_TOAST_MS,
    action: {
      label: tUi('trash.undo.action'),
      run: () => void putBack(origins, action)
    }
  });
}
