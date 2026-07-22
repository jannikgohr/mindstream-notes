import {
  assertNumber,
  assertRecord,
  TauriCommandName,
  invokeOrFallback
} from './core';
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
    TauriCommandName.MoveMany,
    { items, targetCollectionId },
    () => moveManyFallback(items, targetCollectionId),
    parseBatchCounts
  );
}

export function trashMany(items: TreeItemRef[]): Promise<BatchCounts> {
  return invokeOrFallback<BatchCounts>(
    TauriCommandName.TrashMany,
    { items },
    () => moveManyFallback(items, TRASH_ID),
    parseBatchCounts
  );
}

export function restoreMany(items: TreeItemRef[]): Promise<BatchCounts> {
  return invokeOrFallback<BatchCounts>(
    TauriCommandName.RestoreMany,
    { items },
    () => moveManyFallback(items, null),
    parseBatchCounts
  );
}

export function purgeMany(items: TreeItemRef[]): Promise<BatchCounts> {
  return invokeOrFallback<BatchCounts>(
    TauriCommandName.PurgeMany,
    { items },
    async () => {
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
    },
    parseBatchCounts
  );
}

function parseBatchCounts(value: unknown): BatchCounts {
  const raw = assertRecord(value, 'batch counts');
  return {
    notes: assertNumber(raw.notes, 'batch counts.notes'),
    folders: assertNumber(raw.folders, 'batch counts.folders')
  };
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
