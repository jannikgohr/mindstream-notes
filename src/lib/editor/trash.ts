/** Walk the current tree without hanging on a corrupt parent cycle. */
export function ancestorIsTrash(
  parentId: string | null,
  collections: Record<string, { parent_collection_id: string | null }>,
  trashId = 'trash'
): boolean {
  const seen = new Set<string>();
  let current = parentId;
  while (current) {
    if (current === trashId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = collections[current]?.parent_collection_id ?? null;
  }
  return false;
}
