/**
 * Tree shape composed from listCollections + listNotes. The renderer
 * doesn't need ordered SQL — it just wants a tree it can map.
 */

import type { Collection } from './collections';
import type { NoteSummary } from './notes';
import { TRASH_ID } from './index';
import { listCollections } from './collections';
import { listNotes } from './notes';

export interface FolderNode {
  kind: 'folder';
  id: string;
  name: string;
  position: number;
  parent_collection_id: string | null;
  children: TreeNode[];
}

export interface NoteNode {
  kind: 'note';
  id: string;
  name: string;
  position: number;
  parent_collection_id: string | null;
}

export type TreeNode = FolderNode | NoteNode;

export interface LoadedTree {
  tree: TreeNode[];
  notesById: Record<string, NoteSummary>;
  collectionsById: Record<string, Collection>;
}

/** Load both lists from Rust and weave them into a tree. */
export async function loadTree(): Promise<LoadedTree> {
  const [collections, notes] = await Promise.all([
    listCollections(),
    listNotes(true)
  ]);
  return composeTree(collections, notes);
}

export function composeTree(
  collections: Collection[],
  notes: NoteSummary[]
): LoadedTree {
  const folderById = new Map<string, FolderNode>();
  for (const c of collections) {
    folderById.set(c.id, {
      kind: 'folder',
      id: c.id,
      name: c.name,
      position: c.position,
      parent_collection_id: c.parent_collection_id,
      children: []
    });
  }

  // Ensure the special trash folder exists even if the DB doesn't yet have
  // it (e.g. before migration v2 has run, or in an outdated mock seed).
  if (!folderById.has(TRASH_ID)) {
    folderById.set(TRASH_ID, {
      kind: 'folder',
      id: TRASH_ID,
      name: 'Trash',
      position: 9999999,
      parent_collection_id: null,
      children: []
    });
  }

  const roots: TreeNode[] = [];

  // Plug folders into their parents (or the root array).
  for (const f of folderById.values()) {
    if (f.parent_collection_id) {
      const parent = folderById.get(f.parent_collection_id);
      if (parent) parent.children.push(f);
      else roots.push(f); // dangling parent — surface at root
    } else {
      roots.push(f);
    }
  }

  // Plug notes in.
  for (const n of notes) {
    const node: NoteNode = {
      kind: 'note',
      id: n.id,
      name: n.title,
      position: n.position,
      parent_collection_id: n.parent_collection_id
    };
    if (n.parent_collection_id) {
      const parent = folderById.get(n.parent_collection_id);
      if (parent) parent.children.push(node);
      else roots.push(node);
    } else {
      roots.push(node);
    }
  }

  const notesById: Record<string, NoteSummary> = {};
  for (const n of notes) notesById[n.id] = n;
  const collectionsById: Record<string, Collection> = {};
  for (const c of collections) collectionsById[c.id] = c;

  return { tree: roots, notesById, collectionsById };
}
