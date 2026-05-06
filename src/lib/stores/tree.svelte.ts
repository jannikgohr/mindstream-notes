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
import { TRASH_ID } from '$lib/api';
import { ui } from '$lib/state.svelte';
import { getSettingValue } from '$lib/settings/store.svelte';

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

/**
 * Trash a note. With `data.useTrash` enabled the note moves to the special
 * trash collection (still in the tree, just under "Trash"). Without it,
 * the note is soft-deleted via `trashed_at` and disappears from listings.
 */
export async function trashNote(id: string): Promise<void> {
  if (getSettingValue('data.useTrash')) {
    await moveNoteTo(id, TRASH_ID);
  } else {
    await api.trashNote(id);
    delete tree.notesById[id];
    removeNoteNode(tree.tree, id);
    if (ui.activeNoteId === id) ui.activeNoteId = null;
  }
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

/**
 * Replace the tag list on a note. Optimistic — patches the in-memory summary
 * so the metadata panel updates without a full tree refetch. Tags are
 * normalized (trimmed + de-duped) before persisting.
 */
export async function setNoteTags(id: string, tags: string[]): Promise<void> {
  const normalized = normalizeTags(tags);
  await api.saveNote({ id, tags: normalized });
  const existing = tree.notesById[id];
  if (existing) {
    tree.notesById[id] = {
      ...existing,
      tags: normalized,
      modified: new Date().toISOString()
    };
  }
}

/**
 * Add a tag to a note (no-op if the note already has it). Whitespace-only
 * tag names are rejected.
 */
export async function addNoteTag(id: string, tag: string): Promise<void> {
  const trimmed = tag.trim();
  if (!trimmed) return;
  const existing = tree.notesById[id];
  if (!existing) return;
  if (existing.tags.includes(trimmed)) return;
  await setNoteTags(id, [...existing.tags, trimmed]);
}

/** Remove a tag from a note. Silent no-op if it isn't present. */
export async function removeNoteTag(id: string, tag: string): Promise<void> {
  const existing = tree.notesById[id];
  if (!existing) return;
  if (!existing.tags.includes(tag)) return;
  await setNoteTags(
    id,
    existing.tags.filter((t) => t !== tag)
  );
}

/**
 * Every distinct tag currently in use across all (non-trashed) notes,
 * sorted case-insensitively. Used by the tag picker to surface previously
 * created tags for re-use.
 */
export function allTagsInUse(): string[] {
  const set = new Set<string>();
  for (const n of Object.values(tree.notesById)) {
    if (n.trashed) continue;
    for (const t of n.tags) set.add(t);
  }
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function normalizeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
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

/**
 * Trash a folder. Same semantics as trashNote: move to trash when the
 * setting is enabled, hard-delete otherwise.
 */
export async function trashCollection(id: string): Promise<void> {
  if (getSettingValue('data.useTrash')) {
    await moveCollectionTo(id, TRASH_ID);
  } else {
    await api.deleteCollection(id);
    await loadTree();
  }
}

// ---------- Trash actions (operate on items already inside trash) ----------

/** Move a trashed note back to root. */
export async function restoreNote(id: string): Promise<void> {
  await moveNoteTo(id, null);
}

/** Permanently delete a note from the database. */
export async function purgeNote(id: string): Promise<void> {
  await api.purgeNote(id);
  await loadTree();
}

/** Move a trashed folder back to root. */
export async function restoreCollection(id: string): Promise<void> {
  await moveCollectionTo(id, null);
}

/** Permanently delete a folder (cascades to its notes via FK). */
export async function purgeCollection(id: string): Promise<void> {
  await api.deleteCollection(id);
  await loadTree();
}

/**
 * Permanently delete every direct child of the trash collection.
 * Done in parallel — for typical note counts the round-trip cost
 * dominates, not server-side throughput.
 */
export async function emptyTrash(): Promise<void> {
  const trashedNotes = Object.values(tree.notesById).filter(
    (n) => n.parent_collection_id === TRASH_ID
  );
  const trashedColls = Object.values(tree.collectionsById).filter(
    (c) => c.parent_collection_id === TRASH_ID
  );
  await Promise.all([
    ...trashedNotes.map((n) => api.purgeNote(n.id)),
    ...trashedColls.map((c) => api.deleteCollection(c.id))
  ]);
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
