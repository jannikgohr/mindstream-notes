/**
 * Sort strategies for the file tree. Adding a new strategy is a one-line
 * change: drop a comparator into COMPARATORS and a label into
 * SORT_STRATEGIES — FileExplorer picks them up automatically.
 */

import type { NoteSummary } from './api';
import type { FolderNode, TreeNode } from './api';
import {getSettingValue} from "$lib/settings/store.svelte";

export type SortStrategy = 'alphabetical' | 'modified' | 'created';

export interface SortStrategyOption {
  id: SortStrategy;
  label: string;
}

export const SORT_STRATEGIES: SortStrategyOption[] = [
  { id: 'alphabetical', label: 'Alphabetical' },
  { id: 'modified', label: 'Recently modified' },
  { id: 'created', label: 'Recently created' }
];

interface SortContext {
  notesById: Record<string, NoteSummary>;
}

type Comparator = (a: TreeNode, b: TreeNode, ctx: SortContext) => number;

function labelOf(node: TreeNode): string {
  return node.name;
}

function alphabetical(a: TreeNode, b: TreeNode): number {
  return labelOf(a).localeCompare(labelOf(b), undefined, { sensitivity: 'base' });
}

function noteModified(node: TreeNode, ctx: SortContext): string {
  if (node.kind !== 'note') return '';
  return ctx.notesById[node.id]?.modified ?? '';
}

function noteCreated(node: TreeNode, ctx: SortContext): string {
  if (node.kind !== 'note') return '';
  return ctx.notesById[node.id]?.created ?? '';
}

const COMPARATORS: Record<SortStrategy, Comparator> = {
  alphabetical,
  modified: (a, b, ctx) => {
    if (a.kind !== 'note' || b.kind !== 'note') return alphabetical(a, b);
    return noteModified(b, ctx).localeCompare(noteModified(a, ctx));
  },
  created: (a, b, ctx) => {
    if (a.kind !== 'note' || b.kind !== 'note') return alphabetical(a, b);
    return noteCreated(b, ctx).localeCompare(noteCreated(a, ctx));
  }
};

export function sortTree(
  tree: TreeNode[],
  strategy: SortStrategy,
  ctx: SortContext
): TreeNode[] {
  const strategyCompare = COMPARATORS[strategy] ?? COMPARATORS.alphabetical;
  const foldersFirst = Boolean(getSettingValue('appearance.foldersFirst'));

  // Define a unified comparator
  const unifiedCompare = (a: TreeNode, b: TreeNode) => {
    if (foldersFirst && a.kind !== b.kind) {
      return a.kind === 'folder' ? -1 : 1;
    }

    // If both are folders and foldersFirst is on, original code forced alphabetical
    if (foldersFirst && a.kind === 'folder' && b.kind === 'folder') {
      return alphabetical(a, b);
    }

    return strategyCompare(a, b, ctx);
  };

  // Sort the current level and recursively handle children in one go
  return [...tree]
      .sort(unifiedCompare)
      .map((node) => {
        if (node.kind === 'folder' && node.children?.length > 0) {
          return {
            ...node,
            children: sortTree(node.children, strategy, ctx),
          };
        }
        return node;
      });
}
