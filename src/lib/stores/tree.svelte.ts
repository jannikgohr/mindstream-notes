/**
 * Reactive file tree, hydrated from the Rust API.
 *
 * The store is the only place the rest of the app reads tree data from;
 * mutations call the API and refetch (cheap for desktop note counts —
 * upgrade to optimistic in-place updates if you ever hit perf limits).
 *
 * IDs everywhere: collections and notes both have stable string ids. The
 * older name-based API has been retired; the only place a name is used
 * is the visible label.
 */

import * as api from '$lib/api';
import type { Collection, NoteSummary, TreeNode } from '$lib/api';
import { ui } from '$lib/state.svelte';

interface TreeState {
  tree: TreeNode[];
  notesById: Record<string, NoteSummary>;
  collectionsById: Record<string, Collection>;
  loading: boolean;
  error: string | null;
  /** Has loadTree() ever resolved? Used by Layout to gate the dock setup. */
  ready: boolean;
}

export const tree = $state<TreeState>({
  tree: [],
  notesById: {},
  collectionsById: {},
  loading: false,
  error: null,
  ready: false
});

/** Reload the tree + summaries from Rust. Idempotent. */
export async function loadTree(): Promise<void> {
  tree.loading = true;
  tree.error = null;
  try {
    const result = await api.loadTree();
    tree.tree = result.tree;
    tree.notesById = result.notesById;
    tree.collectionsById = result.collectionsById;
    tree.ready = true;
  } catch (err) {
    tree.error = err instanceof Error ? err.message : String(err);
    console.error('[tree] loadTree failed', err);
  } finally {
    tree.loading = false;
  }
}

// ---------- Notes ----------

export async function createNoteIn(
  parentId: string | null,
  title?: string
): Promise<string> {
  const note = await api.createNote({ parent_collection_id: parentId, title });
  await loadTree();
  return note.id;
}

export async function renameNote(id: string, title: string): Promise<void> {
  await api.saveNote({ id, title });
  // Optimistic update so the UI doesn't flash through a refetch.
  const existing = tree.notesById[id];
  if (existing) {
    tree.notesById[id] = {
      ...existing,
      title,
      modified: new Date().toISOString()
    };
  }
  patchNodeName(tree.tree, id, title);
}

export async function trashNote(id: string): Promise<void> {
  await api.trashNote(id);
  delete tree.notesById[id];
  removeNoteNode(tree.tree, id);
  if (ui.activeNoteId === id) ui.activeNoteId = null;
}

export async function trashFolder(id: string): Promise<void> {
  // TODO: delete folder api / move to trash
}

export async function moveNoteTo(
  noteId: string,
  targetCollectionId: string | null
): Promise<void> {
  await api.saveNote({ id: noteId, parent_collection_id: targetCollectionId });
  await loadTree();
}

export async function setNoteBody(id: string, body: string): Promise<void> {
  await api.saveNote({ id, body });
  const existing = tree.notesById[id];
  if (existing) {
    tree.notesById[id] = { ...existing, modified: new Date().toISOString() };
  }
}

// ---------- Collections ----------

export async function createCollectionIn(
  parentId: string | null,
  name: string
): Promise<string> {
  const c = await api.createCollection({ name, parent_collection_id: parentId });
  await loadTree();
  return c.id;
}

export async function renameCollection(
  id: string,
  name: string
): Promise<void> {
  await api.updateCollection({ id, name });
  await loadTree();
}

export async function moveCollectionTo(
  collectionId: string,
  targetCollectionId: string | null
): Promise<void> {
  await api.updateCollection({
    id: collectionId,
    parent_collection_id: targetCollectionId
  });
  await loadTree();
}

export async function deleteCollectionById(id: string): Promise<void> {
  await api.deleteCollection(id);
  await loadTree();
}

// ---------- Internal: in-place tree patches for optimistic updates ----------

function patchNodeName(nodes: TreeNode[], id: string, name: string): void {
  for (const n of nodes) {
    if (n.kind === 'note' && n.id === id) {
      n.name = name;
      return;
    }
    if (n.kind === 'folder') {
      patchNodeName(n.children, id, name);
    }
  }
}

function removeNoteNode(nodes: TreeNode[], id: string): boolean {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === 'note' && n.id === id) {
      nodes.splice(i, 1);
      return true;
    }
    if (n.kind === 'folder' && removeNoteNode(n.children, id)) return true;
  }
  return false;
}
