export interface HorizontalReorderItem {
  id: string;
}

/**
 * Compute the insertion index for a horizontal strip from item midpoints.
 * The dragged item is ignored because it is represented by a placeholder/ghost
 * during the drag.
 */
export function horizontalInsertionIndex(
  items: readonly HorizontalReorderItem[],
  sourceId: string,
  itemElements: readonly HTMLElement[],
  clientX: number
): number {
  const visibleItems = items.filter((item) => item.id !== sourceId);
  let index = visibleItems.length;
  for (let i = 0; i < visibleItems.length; i++) {
    const element = itemElements.find(
      (el) => el.dataset.reorderId === visibleItems[i].id
    );
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      index = i;
      break;
    }
  }
  return index;
}

export function moveItemToIndex<T extends HorizontalReorderItem>(
  items: readonly T[],
  sourceId: string,
  insertIndex: number
): T[] {
  const sourceIndex = items.findIndex((item) => item.id === sourceId);
  if (sourceIndex < 0) return [...items];

  const next = [...items];
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(Math.max(0, Math.min(insertIndex, next.length)), 0, moved);
  return next;
}
