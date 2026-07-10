import { invokeOrFallback } from './core';
import { mockApi } from './mock-store';
import { TRASH_ID } from './index';

export type TreeItemRef =
  | { kind: 'note'; id: string }
  | { kind: 'folder'; id: string };

export interface BatchCounts {
  notes: number;
  folders: number;
}

export function moveMany(
  items: TreeItemRef[],
  targetCollectionId: string | null
): Promise<BatchCounts> {
  return invokeOrFallback<BatchCounts>(
    'move_many',
    { items, targetCollectionId },
    () => moveManyFallback(items, targetCollectionId)
  );
}

export function trashMany(items: TreeItemRef[]): Promise<BatchCounts> {
  return invokeOrFallback<BatchCounts>('trash_many', { items }, () =>
    moveManyFallback(items, TRASH_ID)
  );
}

export function restoreMany(items: TreeItemRef[]): Promise<BatchCounts> {
  return invokeOrFallback<BatchCounts>('restore_many', { items }, () =>
    moveManyFallback(items, null)
  );
}

export function purgeMany(items: TreeItemRef[]): Promise<BatchCounts> {
  return invokeOrFallback<BatchCounts>('purge_many', { items }, async () => {
    const counts: BatchCounts = { notes: 0, folders: 0 };
    for (const item of items) {
      if (item.kind === 'note') {
        await mockApi.purgeNote(item.id);
        counts.notes += 1;
      } else {
        await mockApi.deleteCollection(item.id);
        counts.folders += 1;
      }
    }
    return counts;
  });
}

async function moveManyFallback(
  items: TreeItemRef[],
  targetCollectionId: string | null
): Promise<BatchCounts> {
  const counts: BatchCounts = { notes: 0, folders: 0 };
  for (const item of items) {
    if (item.kind === 'note') {
      await mockApi.saveNote({
        id: item.id,
        parent_collection_id: targetCollectionId
      });
      counts.notes += 1;
    } else {
      await mockApi.updateCollection({
        id: item.id,
        parent_collection_id: targetCollectionId
      });
      counts.folders += 1;
    }
  }
  return counts;
}
