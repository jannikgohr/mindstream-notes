/**
 * Sort strategies for the file tree. Adding a new strategy is a one-line
 * change: drop a comparator into COMPARATORS and a label into
 * SORT_STRATEGIES — FileExplorer picks them up automatically.
 *
 * Strategy + direction are orthogonal: strategy chooses the field to
 * compare; direction (asc / desc) chooses whether to flip the result.
 * The asc-form of each comparator is the "natural" reading order for
 * the field (A→Z, oldest first, etc.); desc just negates that.
 */

import type { Collection, NoteSummary, TreeNode } from './api';
import { getSettingValue } from '$lib/settings/store.svelte';
import { compareLabels } from '$lib/utils';

export type SortStrategy = 'alphabetical' | 'modified' | 'created';
export type SortDirection = 'asc' | 'desc';

export interface SortStrategyOption {
  id: SortStrategy;
  /**
   * i18n key under `ui.*` that resolves to the human-readable label —
   * components pass it through `tUi()` so the picker is localised.
   */
  labelKey: string;
}

export const SORT_STRATEGIES: SortStrategyOption[] = [
  { id: 'alphabetical', labelKey: 'sort.strategy.alphabetical' },
  { id: 'modified', labelKey: 'sort.strategy.modified' },
  { id: 'created', labelKey: 'sort.strategy.created' }
];

interface SortContext {
  notesById: Record<string, NoteSummary>;
  collectionsById: Record<string, Collection>;
}

type Comparator = (a: TreeNode, b: TreeNode, ctx: SortContext) => number;

function labelOf(node: TreeNode): string {
  return node.name;
}

/** A→Z. */
function alphabetical(a: TreeNode, b: TreeNode): number {
  return compareLabels(labelOf(a), labelOf(b));
}

function timestamp(
  node: TreeNode,
  field: 'created' | 'modified',
  ctx: SortContext
): string {
  const item =
    node.kind === 'note'
      ? ctx.notesById[node.id]
      : ctx.collectionsById[node.id];
  return item?.[field] ?? '';
}

/**
 * Comparators are written in *ascending* form: smaller comes first.
 * `sortTree` flips the sign when direction === 'desc'. Modified/created
 * compare ISO strings (which sort chronologically as plain strings), so
 * asc = oldest first, desc = newest first. Folders compare by their own
 * timestamps too: mixing in name order for them breaks transitivity.
 */
const COMPARATORS: Record<SortStrategy, Comparator> = {
  alphabetical,
  modified: (a, b, ctx) =>
    timestamp(a, 'modified', ctx).localeCompare(
      timestamp(b, 'modified', ctx)
    ) || alphabetical(a, b),
  created: (a, b, ctx) =>
    timestamp(a, 'created', ctx).localeCompare(timestamp(b, 'created', ctx)) ||
    alphabetical(a, b)
};

export function sortTree(
  tree: TreeNode[],
  strategy: SortStrategy,
  ctx: SortContext,
  direction: SortDirection = 'asc'
): TreeNode[] {
  const strategyCompare = COMPARATORS[strategy] ?? COMPARATORS.alphabetical;
  const foldersFirst = Boolean(getSettingValue('appearance.foldersFirst'));
  const factor = direction === 'desc' ? -1 : 1;

  const unifiedCompare = (a: TreeNode, b: TreeNode) => {
    if (foldersFirst && a.kind !== b.kind) {
      return a.kind === 'folder' ? -1 : 1;
    }
    // Folders always sort alphabetically inside their own bucket — the
    // strategy field "recently modified" is meaningless for them.
    if (foldersFirst && a.kind === 'folder' && b.kind === 'folder') {
      return alphabetical(a, b) * factor;
    }
    return strategyCompare(a, b, ctx) * factor;
  };

  return [...tree].sort(unifiedCompare).map((node) => {
    if (node.kind === 'folder' && node.children?.length > 0) {
      return {
        ...node,
        children: sortTree(node.children, strategy, ctx, direction)
      };
    }
    return node;
  });
}
