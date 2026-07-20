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
import type {
  Collection,
  NoteKind,
  NoteSummary,
  TreeItemRef,
  TreeNode
} from '$lib/api';
import { TRASH_ID } from '$lib/api';
import { runSync } from '$lib/sync/runner';
import { extractPdfText } from '$lib/pdf/extract-text';

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

// Coalesces concurrent callers onto a single in-flight fetch. Startup fires
// loadTree() from onMount and again from the dockview bootstrap; without this
// they'd race two fetches whose assignments could interleave.
let inFlight: Promise<void> | null = null;

/** Reload the tree + summaries from Rust. Idempotent. */
export function loadTree(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = doLoadTree().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doLoadTree(): Promise<void> {
  tree.loading = true;
  tree.error = null;
  try {
    const result = await api.loadTree();
    tree.tree = result.tree;
    tree.notesById = result.notesById;
    tree.collectionsById = result.collectionsById;
  } catch (err) {
    tree.error = err instanceof Error ? err.message : String(err);
    console.error('[tree] loadTree failed', err);
  } finally {
    // `ready` means "a load attempt has completed", not "succeeded" — so a
    // failed load drops out of the loading state and lets the UI surface
    // tree.error instead of an eternal spinner. Callers that need success
    // should check tree.error.
    tree.ready = true;
    tree.loading = false;
  }
}

// ---------- Notes ----------

export async function createNoteIn(
  parentId: string | null,
  title?: string,
  noteKind?: NoteKind
): Promise<string> {
  const note = await api.createNote({
    parent_collection_id: parentId,
    title,
    note_kind: noteKind
  });
  await loadTree();
  // Live collab keys live on the etebase server — the per-note crypto_key
  // doesn't exist locally until the first push, and the room id is the
  // etebase Item UID. Kicking off a sync now means the note can join its
  // live room as soon as the round-trip completes; NoteEditor reactively
  // (re-)inits its CollabProvider once tree.notesById[id].etebase_uid is
  // populated by the post-push loadTree.
  //
  // Best-effort: silent on offline / not-signed-in failures. If runner
  // coalesced our call with a periodic sync that started just before the
  // create, that earlier sync wouldn't have seen the new dirty row — so
  // we re-run once if the note still hasn't been pushed.
  void (async () => {
    try {
      await runSync();
      if (!tree.notesById[note.id]?.pushed) {
        await runSync();
      }
    } catch (err) {
      console.debug('[tree] post-create sync failed', err);
    }
  })();
  return note.id;
}

export async function importPdfIn(
  parentId: string | null,
  file: File
): Promise<string> {
  const raw = new Uint8Array(await file.arrayBuffer());
  const bytes = Array.from(raw);
  const title = file.name.replace(/\.pdf$/i, '').trim() || 'Untitled PDF';
  const note = await api.importPdfNote({
    parent_collection_id: parentId,
    title,
    bytes
  });
  await loadTree();
  // Index the PDF's text for cross-note search. Derived/local-only, so it
  // runs off the import path and failures are non-fatal (the background
  // sweep retries un-indexed PDFs later).
  void (async () => {
    try {
      const text = await extractPdfText(raw);
      await api.setPdfText(note.id, text);
    } catch (err) {
      console.debug('[tree] pdf text extraction failed', err);
    }
  })();
  void (async () => {
    try {
      await runSync();
      if (!tree.notesById[note.id]?.pushed) {
        await runSync();
      }
    } catch (err) {
      console.debug('[tree] post-pdf-import sync failed', err);
    }
  })();
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

/** Move a note into the special trash collection. */
export async function trashNote(id: string): Promise<void> {
  await moveNoteTo(id, TRASH_ID);
}

export async function moveNoteTo(
  noteId: string,
  targetCollectionId: string | null
): Promise<void> {
  await api.saveNote({ id: noteId, parent_collection_id: targetCollectionId });
  await loadTree();
}

export async function moveManyTo(
  items: TreeItemRef[],
  targetCollectionId: string | null
): Promise<api.BatchCounts> {
  const result = await api.moveMany(items, targetCollectionId);
  await loadTree();
  return result;
}

export async function setNoteBody(id: string, body: string): Promise<void> {
  await api.saveNote({ id, body });
  const existing = tree.notesById[id];
  if (existing) {
    tree.notesById[id] = { ...existing, modified: new Date().toISOString() };
  }
}

/**
 * Persist the favourite bit and patch the in-memory summary so any
 * mobile star-icon toggle reflects immediately without waiting on a
 * tree refetch. Backed by the SQLite `notes.favourite` column and
 * carried across devices via the v2 NotePayload (see sync/mod.rs).
 */
export async function setNoteFavourite(
  id: string,
  favourite: boolean
): Promise<void> {
  await api.saveNote({ id, favourite });
  const existing = tree.notesById[id];
  if (existing) {
    tree.notesById[id] = {
      ...existing,
      favourite,
      modified: new Date().toISOString()
    };
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
  const normalized = normalizeTagPath(tag);
  if (!normalized) return;
  const existing = tree.notesById[id];
  if (!existing) return;
  if (existing.tags.includes(normalized)) return;
  await setNoteTags(id, [...existing.tags, normalized]);
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
  return [...set].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );
}

/**
 * Canonical tag form. Nested tags use "/" as the segment separator
 * (Obsidian convention); each segment is trimmed and empty segments are
 * dropped, so " work / urgent " collapses to "work/urgent" and "work//foo"
 * collapses to "work/foo".
 */
export function normalizeTagPath(raw: string): string {
  return raw
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('/');
}

function normalizeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = normalizeTagPath(raw);
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
  const c = await api.createCollection({
    name,
    parent_collection_id: parentId
  });
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

/** Move a folder into the special trash collection. */
export async function trashCollection(id: string): Promise<void> {
  await moveCollectionTo(id, TRASH_ID);
}

/**
 * Leave a folder that was shared with the current user: relinquishes membership
 * server-side and purges the locally-pulled subtree, then refreshes the tree so
 * the folder disappears from the "Shared" view.
 */
export async function leaveSharedCollection(id: string): Promise<void> {
  await api.leaveSharedCollection(id);
  await loadTree();
}

/**
 * Stop sharing a folder the current user owns. The folder stays (as a personal
 * folder); recipients lose access. Refreshes the tree so the shared-by-me badge
 * clears.
 */
export async function stopSharingCollection(id: string): Promise<void> {
  await api.stopSharingCollection(id);
  await loadTree();
}

export async function trashMany(
  items: TreeItemRef[]
): Promise<api.BatchCounts> {
  const result = await api.trashMany(items);
  await loadTree();
  return result;
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

export async function restoreMany(
  items: TreeItemRef[]
): Promise<api.BatchCounts> {
  const result = await api.restoreMany(items);
  await loadTree();
  return result;
}

export async function purgeMany(
  items: TreeItemRef[]
): Promise<api.BatchCounts> {
  const result = await api.purgeMany(items);
  await loadTree();
  return result;
}

/**
 * Permanently delete every item under the trash collection — including
 * notes nested in sub-folders. The Rust side does it in one transaction
 * (see src-tauri/src/data.rs); the returned counts feed any "deleted N
 * items" UX the caller wants.
 */
export async function emptyTrash(): Promise<api.TrashCounts> {
  const result = await api.emptyTrashCmd();
  await loadTree();
  return result;
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
