import { Home, PencilRuler, Share2, Star, Trash2 } from '@lucide/svelte';
import type { NoteKind, TreeNode } from '$lib/api';
import type { IconComponent } from '$lib/settings/icons';
import type { DesktopNoteSource } from '$lib/stores/note-source.svelte';

export type DraftKind = 'note' | 'folder' | 'drawing' | 'ink' | 'kanban';
export type Draft = {
  kind: DraftKind;
  parentId: string | null;
  text: string;
};

export type Rename = {
  kind: 'note' | 'folder';
  id: string;
  new_name: string;
};

export type MenuTarget =
  | { kind: 'note'; id: string }
  | { kind: 'folder'; id: string }
  | { kind: 'root' };

export type TreeItemRef =
  | { kind: 'note'; id: string }
  | { kind: 'folder'; id: string };

export type SelectionKey = `n:${string}` | `f:${string}`;

export interface SelectionClickModifiers {
  toggle: boolean;
  range: boolean;
}

export interface SelectionClickResult {
  selected: SelectionKey[];
  anchor: SelectionKey | null;
  active: SelectionKey;
}

export type Drag =
  | { kind: 'note'; id: string; items?: TreeItemRef[] }
  | { kind: 'folder'; id: string; items?: TreeItemRef[] }
  | null;

export const FILE_EXPLORER_SOURCES: {
  id: DesktopNoteSource;
  labelKey: string;
  icon: IconComponent;
}[] = [
  {
    id: 'home',
    labelKey: 'nav.home',
    icon: Home as unknown as IconComponent
  },
  {
    id: 'favourites',
    labelKey: 'nav.favourite',
    icon: Star as unknown as IconComponent
  },
  {
    id: 'shared',
    labelKey: 'nav.shared',
    icon: Share2 as unknown as IconComponent
  },
  {
    id: 'trash',
    labelKey: 'nav.trash',
    icon: Trash2 as unknown as IconComponent
  }
];

export function defaultDraftText(kind: DraftKind): string {
  switch (kind) {
    case 'folder':
      return 'Untitled folder';
    case 'drawing':
      return 'Untitled drawing canvas';
    case 'ink':
      return 'Untitled handwritten note';
    case 'kanban':
      return 'Untitled board';
    case 'note':
      return 'Untitled';
  }
}

export function draftKindToNoteKind(kind: DraftKind): NoteKind | null {
  switch (kind) {
    case 'drawing':
      return 'freeform';
    case 'ink':
      return 'ink';
    case 'kanban':
      return 'kanban';
    case 'note':
      return 'markdown';
    case 'folder':
      return null;
  }
}

export function nodeKey(n: TreeNode): string {
  return n.kind === 'folder' ? `f:${n.id}` : `n:${n.id}`;
}

export function selectionKeyForItem(item: TreeItemRef): SelectionKey {
  return item.kind === 'folder' ? `f:${item.id}` : `n:${item.id}`;
}

export function itemFromSelectionKey(key: SelectionKey): TreeItemRef {
  const [prefix, ...rest] = key.split(':');
  const id = rest.join(':');
  return prefix === 'f' ? { kind: 'folder', id } : { kind: 'note', id };
}

export function itemFromNode(node: TreeNode): TreeItemRef {
  return { kind: node.kind, id: node.id };
}

export function visibleSelectionKeys(
  nodes: TreeNode[],
  expanded: Record<string, boolean>
): SelectionKey[] {
  const keys: SelectionKey[] = [];
  for (const node of nodes) {
    keys.push(nodeKey(node) as SelectionKey);
    if (node.kind === 'folder' && expanded[node.id]) {
      keys.push(...visibleSelectionKeys(node.children, expanded));
    }
  }
  return keys;
}

export function updateSelectionForClick(
  current: SelectionKey[],
  clicked: SelectionKey,
  visibleKeys: SelectionKey[],
  anchor: SelectionKey | null,
  active: SelectionKey | null,
  modifiers: SelectionClickModifiers
): SelectionClickResult {
  if (modifiers.range) {
    const rangeStart = anchor ?? active ?? clicked;
    const range = selectionRange(visibleKeys, rangeStart, clicked);
    if (modifiers.toggle) {
      return {
        selected: mergeSelection(current, range),
        anchor: rangeStart,
        active: clicked
      };
    }
    return { selected: range, anchor: rangeStart, active: clicked };
  }

  if (modifiers.toggle) {
    const selected =
      current.length === 0 ? [clicked] : toggleSelection(current, clicked);
    return {
      selected,
      anchor: selected.length > 0 ? clicked : null,
      active: clicked
    };
  }

  return { selected: [], anchor: null, active: clicked };
}

export function selectionRange(
  visibleKeys: SelectionKey[],
  from: SelectionKey,
  to: SelectionKey
): SelectionKey[] {
  const fromIndex = visibleKeys.indexOf(from);
  const toIndex = visibleKeys.indexOf(to);
  if (fromIndex === -1 || toIndex === -1) return [to];
  const start = Math.min(fromIndex, toIndex);
  const end = Math.max(fromIndex, toIndex);
  return visibleKeys.slice(start, end + 1);
}

export function toggleSelection(
  current: SelectionKey[],
  key: SelectionKey
): SelectionKey[] {
  if (current.includes(key)) return current.filter((item) => item !== key);
  return [...current, key];
}

export function mergeSelection(
  current: SelectionKey[],
  next: SelectionKey[]
): SelectionKey[] {
  const selected = new Set(current);
  for (const key of next) selected.add(key);
  return [...selected];
}

export function selectedItemsFromKeys(keys: SelectionKey[]): TreeItemRef[] {
  return keys.map(itemFromSelectionKey);
}

export function dragItemsForStart(
  item: TreeItemRef,
  selectedKeys: SelectionKey[]
): TreeItemRef[] {
  const key = selectionKeyForItem(item);
  if (!selectedKeys.includes(key)) return [item];
  const items = selectedItemsFromKeys(selectedKeys);
  return items.length > 0 ? items : [item];
}

function parseTreeItemRef(value: unknown): TreeItemRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const item = value as { kind?: unknown; id?: unknown };
  if (
    (item.kind !== 'note' && item.kind !== 'folder') ||
    typeof item.id !== 'string' ||
    item.id.length === 0
  ) {
    return null;
  }
  return { kind: item.kind, id: item.id };
}

function parseTreeItemRefs(value: unknown): TreeItemRef[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const items: TreeItemRef[] = [];
  for (const item of value) {
    const parsed = parseTreeItemRef(item);
    if (!parsed) return null;
    items.push(parsed);
  }
  return items;
}

export function emptyStateMessageForSource(
  source: DesktopNoteSource,
  emptyRootLabel: string
): string {
  switch (source) {
    case 'favourites':
      return 'Favourite notes will appear here.';
    case 'shared':
      return 'Shared folders will appear here.';
    case 'trash':
      return 'Trash is empty.';
    case 'home':
      return emptyRootLabel;
  }
}

export function dragPayloadFromTransfer(
  dataTransfer: DataTransfer | null
): Drag {
  if (!dataTransfer) return null;
  const treeItems = dataTransfer.getData('application/x-tree-items');
  if (treeItems) {
    try {
      const items = parseTreeItemRefs(JSON.parse(treeItems));
      const first = items?.[0];
      if (first) {
        return { ...first, items };
      }
    } catch {
      // Fall back to legacy single-item payloads below.
    }
  }
  const noteId = dataTransfer.getData('application/x-note-id');
  if (noteId) return { kind: 'note', id: noteId };
  const folderId = dataTransfer.getData('application/x-folder-id');
  if (folderId) return { kind: 'folder', id: folderId };
  return null;
}
