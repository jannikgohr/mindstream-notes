import {
  TRASH_ID,
  type Collection,
  type NoteSummary,
  type TreeItemRef,
  type TreeNode
} from '$lib/api';

export type DesktopNoteSource = 'home' | 'favourites' | 'shared' | 'trash';

interface DesktopNoteSourceState {
  active: DesktopNoteSource;
}

export const desktopNoteSource = $state<DesktopNoteSourceState>({
  active: 'home'
});

export function setDesktopNoteSource(source: DesktopNoteSource) {
  desktopNoteSource.active = source;
}

export function childrenOf(
  folderId: string | null,
  roots: TreeNode[]
): TreeNode[] {
  if (folderId === null) return roots;
  const stack: TreeNode[] = [...roots];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.kind !== 'folder') continue;
    if (node.id === folderId) return node.children;
    stack.push(...node.children);
  }
  return [];
}

export function collectionIsUnder(
  collectionId: string | null,
  ancestorId: string,
  collectionsById: Record<string, Collection>
): boolean {
  let current = collectionId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = collectionsById[current]?.parent_collection_id ?? null;
  }
  return false;
}

export function collectionIsUnderTrash(
  collectionId: string | null,
  collectionsById: Record<string, Collection>
): boolean {
  return collectionIsUnder(collectionId, TRASH_ID, collectionsById);
}

export function noteIsUnderTrash(
  note: NoteSummary,
  collectionsById: Record<string, Collection>
): boolean {
  return (
    note.trashed ||
    collectionIsUnderTrash(note.parent_collection_id, collectionsById)
  );
}

export function collectionIsSharedRoot(
  collection: Collection,
  collectionsById: Record<string, Collection>
): boolean {
  return (
    collectionIsSharedWithMe(collection) &&
    !collectionHasSharedAncestor(collection, collectionsById)
  );
}

export function collectionIsSharedOrUnderShared(
  collectionId: string | null,
  collectionsById: Record<string, Collection>
): boolean {
  let current = collectionId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const collection = collectionsById[current];
    if (!collection) return false;
    if (collectionIsSharedWithMe(collection)) return true;
    current = collection.parent_collection_id;
  }
  return false;
}

/**
 * True when the folder at `collectionId` sits inside (or is) a folder shared
 * *with* the current user at read-only access. The share role is stamped only
 * on the shared root — descendant folders pulled into the scope carry just
 * placement metadata — so we walk ancestors to the first shared-with-me folder
 * and read its `shared_role`. Editors use this to lock input in a view-only
 * scope, mirroring the trash lock. A shared-by-me folder is never read-only for
 * its owner (`collectionIsSharedWithMe` already excludes those).
 */
export function collectionScopeIsReadOnly(
  collectionId: string | null,
  collectionsById: Record<string, Collection>
): boolean {
  let current = collectionId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const collection = collectionsById[current];
    if (!collection) return false;
    if (collectionIsSharedWithMe(collection)) {
      return collection.shared_role === 'read_only';
    }
    current = collection.parent_collection_id;
  }
  return false;
}

/**
 * The id of the shared-with-me root that governs `collectionId`, or `null` when
 * the collection isn't under any share the current user received. Walks ancestors
 * (including the collection itself) to the first `collectionIsSharedWithMe`
 * folder — that folder's id is the "scope identity" the Shared view keys move
 * legality off. A folder shared *by* me is not a shared-with-me root, so it
 * resolves to `null` (owner reorganizes it as a personal folder in Home).
 */
export function sharedRootIdFor(
  collectionId: string | null,
  collectionsById: Record<string, Collection>
): string | null {
  let current = collectionId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const collection = collectionsById[current];
    if (!collection) return null;
    if (collectionIsSharedWithMe(collection)) return collection.id;
    current = collection.parent_collection_id;
  }
  return null;
}

/**
 * The shared root a tree item currently lives under. A note resolves through its
 * parent folder; a folder resolves through itself (a folder is part of its own
 * scope). `null` means the item isn't inside any shared-with-me scope.
 */
export function itemSharedRootId(
  item: TreeItemRef,
  notesById: Record<string, NoteSummary>,
  collectionsById: Record<string, Collection>
): string | null {
  if (item.kind === 'note') {
    const note = notesById[item.id];
    return note
      ? sharedRootIdFor(note.parent_collection_id, collectionsById)
      : null;
  }
  return sharedRootIdFor(item.id, collectionsById);
}

/**
 * True when `folderId` sits inside a shared-with-me scope the user may edit
 * (`read_write` / `admin`). Personal folders (no shared root) and read-only
 * scopes both return false — this helper only answers "is this an *editable
 * shared* target", used to gate create/move affordances in the Shared view.
 */
export function sharedFolderIsEditable(
  folderId: string | null,
  collectionsById: Record<string, Collection>
): boolean {
  const root = sharedRootIdFor(folderId, collectionsById);
  if (!root) return false;
  return !collectionScopeIsReadOnly(root, collectionsById);
}

/**
 * Whether a batch of items may be moved onto `targetFolderId` inside the Shared
 * view. All-or-nothing (the caller blocks the whole drop otherwise):
 *  - the target must be an editable shared folder (not the shared-view root, not
 *    a read-only scope);
 *  - the target must not be one of the dragged folders nor a descendant of one
 *    (would orphan the subtree — mirrors the Home self/descendant guard);
 *  - every item must live in the *same* shared root as the target (intra-scope
 *    only — cross-scope moves are a destructive delete-from-owner + create and
 *    are rejected here).
 */
export function sharedMoveIsLegal(
  items: TreeItemRef[],
  targetFolderId: string | null,
  notesById: Record<string, NoteSummary>,
  collectionsById: Record<string, Collection>
): boolean {
  if (items.length === 0) return false;
  if (targetFolderId === null) return false;
  const destRoot = sharedRootIdFor(targetFolderId, collectionsById);
  if (!destRoot || collectionScopeIsReadOnly(destRoot, collectionsById)) {
    return false;
  }
  for (const item of items) {
    if (item.kind === 'folder') {
      if (item.id === targetFolderId) return false;
      if (collectionIsUnder(targetFolderId, item.id, collectionsById)) {
        return false;
      }
    }
    if (itemSharedRootId(item, notesById, collectionsById) !== destRoot) {
      return false;
    }
  }
  return true;
}

export function noteIsUnderShared(
  note: NoteSummary,
  collectionsById: Record<string, Collection>
): boolean {
  return collectionIsSharedOrUnderShared(
    note.parent_collection_id,
    collectionsById
  );
}

function collectionHasSharedAncestor(
  collection: Collection,
  collectionsById: Record<string, Collection>
): boolean {
  let parent = collection.parent_collection_id;
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const current = collectionsById[parent];
    if (!current) return false;
    if (collectionIsSharedWithMe(current)) return true;
    parent = current.parent_collection_id;
  }
  return false;
}

export function collectionIsSharedWithMe(collection: Collection): boolean {
  const meta = collection as Collection & {
    shared?: boolean;
    is_shared?: boolean;
    shared_role?: string | null;
    share_id?: string | null;
    shared_by_me?: boolean | null;
  };
  if (meta.shared_by_me === true) return false;
  return (
    meta.shared === true ||
    meta.is_shared === true ||
    !!meta.shared_role ||
    !!meta.share_id
  );
}

export function collectionIsSharedByMe(collection: Collection): boolean {
  return collection.shared_by_me === true;
}

export function nodesForDesktopSource(
  source: DesktopNoteSource,
  sortedTree: TreeNode[],
  notesById: Record<string, NoteSummary>,
  collectionsById: Record<string, Collection>
): TreeNode[] {
  switch (source) {
    case 'trash':
      return trashTree(sortedTree, notesById, collectionsById);
    case 'favourites':
      return Object.values(notesById)
        .filter(
          (note) => note.favourite && !noteIsUnderTrash(note, collectionsById)
        )
        .map<TreeNode>((note) => ({
          kind: 'note',
          id: note.id,
          name: note.title,
          position: note.position,
          parent_collection_id: note.parent_collection_id
        }));
    case 'shared':
      return sharedRootNodes(sortedTree, collectionsById);
    case 'home':
      return personalTree(sortedTree, notesById, collectionsById);
  }
}

function personalTree(
  nodes: TreeNode[],
  notesById: Record<string, NoteSummary>,
  collectionsById: Record<string, Collection>
): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'note') {
      const note = notesById[node.id];
      if (note && !noteIsUnderTrash(note, collectionsById)) out.push(node);
      continue;
    }

    const collection = collectionsById[node.id];
    if (node.id === TRASH_ID) continue;
    if (collection && collectionIsSharedRoot(collection, collectionsById)) {
      continue;
    }
    out.push({
      ...node,
      children: personalTree(node.children, notesById, collectionsById)
    });
  }
  return out;
}

function trashTree(
  sortedTree: TreeNode[],
  notesById: Record<string, NoteSummary>,
  collectionsById: Record<string, Collection>
): TreeNode[] {
  const roots = childrenOf(TRASH_ID, sortedTree);
  const renderedNotes = new Set<string>();
  collectNoteIds(roots, renderedNotes);

  const softDeletedNotes = Object.values(notesById)
    .filter((note) => note.trashed && !renderedNotes.has(note.id))
    .map<TreeNode>((note) => ({
      kind: 'note',
      id: note.id,
      name: note.title,
      position: note.position,
      parent_collection_id: note.parent_collection_id
    }));

  return [...roots, ...softDeletedNotes].filter((node) => {
    if (node.kind === 'note') return true;
    return collectionIsUnderTrash(node.id, collectionsById);
  });
}

function collectNoteIds(nodes: TreeNode[], out: Set<string>) {
  for (const node of nodes) {
    if (node.kind === 'note') out.add(node.id);
    else collectNoteIds(node.children, out);
  }
}

function sharedRootNodes(
  nodes: TreeNode[],
  collectionsById: Record<string, Collection>
): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of nodes) {
    if (node.kind !== 'folder') continue;
    if (collectionIsUnderTrash(node.id, collectionsById)) continue;
    const collection = collectionsById[node.id];
    if (collection && collectionIsSharedRoot(collection, collectionsById)) {
      out.push(node);
      continue;
    }
    out.push(...sharedRootNodes(node.children, collectionsById));
  }
  return out;
}
