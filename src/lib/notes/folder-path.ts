import { TRASH_ID, type Collection } from '$lib/api';

/** Resolve the folder chain (root -> leaf) for a note's parent. */
export function folderPath(
  parentId: string | null,
  collectionsById: Record<string, Collection>
): Collection[] {
  if (!parentId) return [];
  const out: Collection[] = [];
  let cur: string | null = parentId;
  const seen = new Set<string>();
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const col: Collection | undefined = collectionsById[cur];
    if (!col) break;
    out.push(col);
    cur = col.parent_collection_id;
  }
  return out.reverse();
}

export function folderPathLabel(
  parentId: string | null,
  collectionsById: Record<string, Collection>
): string {
  const path = folderPath(parentId, collectionsById);
  if (path.length === 0) return '';
  // Hide the trash root from labels; callers already avoid showing
  // trashed notes, and "Trash / ..." would be misleading for restored
  // notes whose folder is still under trash.
  return path
    .filter((c) => c.id !== TRASH_ID)
    .map((c) => c.name)
    .join(' / ');
}
