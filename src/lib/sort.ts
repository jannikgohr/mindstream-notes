/**
 * Sort strategies for the file tree. Adding a new strategy is a one-line
 * change: drop a comparator into COMPARATORS and a label into
 * SORT_STRATEGIES — FileExplorer picks them up automatically.
 *
 * Note shape today: the only timestamp on a note is `modified`. Once disk
 * persistence lands you'll likely also want `created` from filesystem
 * stat — see the comparator stub below.
 */

import type { NoteSummary } from './mocks';
import type { FolderNode, TreeNode } from './mocks';

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
  return node.kind === 'folder' ? node.name : node.name;
}

function alphabetical(a: TreeNode, b: TreeNode): number {
  return labelOf(a).localeCompare(labelOf(b), undefined, { sensitivity: 'base' });
}

function noteTimestamp(node: TreeNode, ctx: SortContext): string {
  if (node.kind !== 'note') return '';
  return ctx.notesById[node.id]?.modified ?? '';
}

const COMPARATORS: Record<SortStrategy, Comparator> = {
  alphabetical,
  modified: (a, b, ctx) => {
    if (a.kind !== 'note' || b.kind !== 'note') return alphabetical(a, b);
    // Newer first.
    return noteTimestamp(b, ctx).localeCompare(noteTimestamp(a, ctx));
  },
  // TODO: real `created` needs a creation timestamp on NoteSummary. For
  // now we approximate with the id prefix `note-<Date.now()>` — fresh
  // notes get descending ids, mock notes fall back to alphabetical.
  created: (a, b, ctx) => {
    if (a.kind !== 'note' || b.kind !== 'note') return alphabetical(a, b);
    const ai = idTimestamp(a.id) ?? noteTimestamp(a, ctx);
    const bi = idTimestamp(b.id) ?? noteTimestamp(b, ctx);
    return String(bi).localeCompare(String(ai));
  }
};

function idTimestamp(id: string): number | null {
  const m = /^note-(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/**
 * Return a deep-sorted copy of `tree`. Folders always come first
 * (alphabetical, stable); notes within a level use the requested
 * strategy. Every folder's children are sorted recursively with the
 * same strategy.
 */
export function sortTree(
  tree: TreeNode[],
  strategy: SortStrategy,
  ctx: SortContext
): TreeNode[] {
  const compare = COMPARATORS[strategy] ?? COMPARATORS.alphabetical;
  const folders: FolderNode[] = [];
  const notes: TreeNode[] = [];
  for (const node of tree) {
    if (node.kind === 'folder') folders.push(node);
    else notes.push(node);
  }
  folders.sort((a, b) => alphabetical(a, b));
  notes.sort((a, b) => compare(a, b, ctx));
  const sortedFolders = folders.map((f) => ({
    ...f,
    children: sortTree(f.children, strategy, ctx)
  }));
  return [...sortedFolders, ...notes];
}
