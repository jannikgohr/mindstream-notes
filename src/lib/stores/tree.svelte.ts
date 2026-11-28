/**
 * Reactive file tree, hydrated from the Rust API.
 *
 * The store is the only place the rest of the app reads tree data from;
 * single-item mutations apply the returned metadata. Sync and subtree
 * mutations reload one database snapshot.
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
import { composeTree } from '$lib/api/tree';
import { compareLabels } from '$lib/utils';
import { runSync } from '$lib/sync/runner';
import { extractPdfText } from '$lib/pdf/extract-text';
import { toErrorMessage } from '$lib/api/errors';
import { emit, TauriEventName } from '$lib/api/events';
import {
  markVaultReady,
  markVaultUnavailable,
  registerVaultAccessProbe
} from '$lib/storage/vault-access.svelte';
import { flushPendingEditorSaves } from '$lib/editor/suspend-flush';
import { ancestorIsTrash } from '$lib/editor/trash';
import { tUi } from '$lib/settings/i18n.svelte';
import { tagsForNewNote } from './tag-filter.svelte';

class TreeState {
  // Raw: replaced whole on every change, never patched in place. A deep
  // proxy over every node made each pass over a large vault slow.
  tree = $state.raw<TreeNode[]>([]);
  notesById = $state<Record<string, NoteSummary>>({});
  collectionsById = $state<Record<string, Collection>>({});
  loading = $state(false);
  error = $state<string | null>(null);
  /** Has loadTree() ever resolved? Used by Layout to gate the dock setup. */
  ready = $state(false);
}

export const tree = new TreeState();

// Coalesces concurrent callers onto a single in-flight fetch. Startup fires
// loadTree() from onMount and again from the dockview bootstrap; without this
// they'd race two fetches whose assignments could interleave.
let inFlight: Promise<void> | null = null;
let pendingReload = false;

/** Reload the tree + summaries from Rust. Idempotent. */
export function loadTree(): Promise<void> {
  if (inFlight) {
    pendingReload = true;
    return inFlight;
  }
  tree.loading = true;
  inFlight = (async () => {
    try {
      do {
        pendingReload = false;
        await doLoadTree();
      } while (pendingReload);
    } finally {
      tree.ready = true;
      tree.loading = false;
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Wait for the load already running, or start one. For callers that need the
 * vault loaded rather than a snapshot newer than their own change: joining
 * keeps a large vault from being read twice at startup.
 */
export function ensureTreeLoaded(): Promise<void> {
  return inFlight ?? loadTree();
}

async function doLoadTree(): Promise<void> {
  tree.error = null;
  try {
    const result = await api.loadTree();
    if (pendingReload) return;
    tree.tree = result.tree;
    tree.notesById = result.notesById;
    tree.collectionsById = result.collectionsById;
    // The vault answered with its notes: this window owns it and may write.
    markVaultReady();
  } catch (err) {
    tree.error = toErrorMessage(err);
    // Includes a browser tab refused the database lock. Writes stay closed
    // until a load succeeds.
    markVaultUnavailable(tree.error);
    console.error('[tree] loadTree failed', err);
  }
}

// A write that arrives before anything has loaded the vault loads it here.
registerVaultAccessProbe(ensureTreeLoaded);

// ---------- Notes ----------

/**
 * `tags` defaults to the tag filter on screen, so a note created while
 * filtering stays in the view it was created from. Pass `[]` for a note that
 * isn't.
 */
export async function createNoteIn(
  parentId: string | null,
  title?: string,
  noteKind?: NoteKind,
  body?: string,
  tags: readonly string[] = tagsForNewNote()
): Promise<string> {
  const created = await api.createNote({
    parent_collection_id: parentId,
    title,
    note_kind: noteKind,
    body
  });
  const note = await withTags(created, tags);
  await applyNoteSummary(note);
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
  const title =
    file.name.replace(/\.pdf$/i, '').trim() ||
    tUi('fileTree.fallback.pdfTitle');
  const imported = await api.importPdfNoteBytes({
    parent_collection_id: parentId,
    title,
    bytes: raw
  });
  const note = await withTags(imported, tagsForNewNote());
  await applyNoteSummary(note);
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
  const modified = new Date().toISOString();
  applyNoteChange({ id, title, modified });
  broadcastNoteChange({ id, title, modified });
  if (inFlight) await loadTree();
}

/** Move a note into the special trash collection. */
export async function trashNote(id: string): Promise<void> {
  await moveNoteTo(id, TRASH_ID);
}

/**
 * An open editor turns read-only once its note lands in the trash, and a
 * read-only editor saves nothing, not even on close. So whatever the editors
 * still hold is saved before anything moves into the trash.
 */
async function saveEditorsBeforeTrashing(
  targetCollectionId: string | null
): Promise<void> {
  if (!ancestorIsTrash(targetCollectionId, tree.collectionsById, TRASH_ID))
    return;
  await flushPendingEditorSaves();
}

export async function moveNoteTo(
  noteId: string,
  targetCollectionId: string | null
): Promise<void> {
  await saveEditorsBeforeTrashing(targetCollectionId);
  const note = await api.saveNote({
    id: noteId,
    parent_collection_id: targetCollectionId
  });
  await applyNoteSummary(note);
}

export async function moveManyTo(
  items: TreeItemRef[],
  targetCollectionId: string | null
): Promise<api.BatchCounts> {
  await saveEditorsBeforeTrashing(targetCollectionId);
  const result = await api.moveMany(items, targetCollectionId);
  await loadTree();
  return result;
}

export async function setNoteBody(
  id: string,
  body: string,
  recoveryToken?: string
): Promise<void> {
  if (recoveryToken) await api.saveNote({ id, body }, recoveryToken);
  else await api.saveNote({ id, body });
  markNoteSaved(id);
  if (inFlight) await loadTree();
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
  if (inFlight) await loadTree();
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
  if (inFlight) await loadTree();
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
  return [...tagsInUse()].sort(compareLabels);
}

/** The distinct tags on non-trashed notes, unsorted. */
export function tagsInUse(): Set<string> {
  const set = new Set<string>();
  for (const n of Object.values(tree.notesById)) {
    if (n.trashed) continue;
    for (const t of n.tags) set.add(t);
  }
  return set;
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
  tree.collectionsById[c.id] = c;
  await finishLocalChange();
  return c.id;
}

export async function renameCollection(
  id: string,
  name: string
): Promise<void> {
  const collection = await api.updateCollection({ id, name });
  tree.collectionsById[id] = collection;
  await finishLocalChange();
}

export async function moveCollectionTo(
  collectionId: string,
  targetCollectionId: string | null
): Promise<void> {
  await saveEditorsBeforeTrashing(targetCollectionId);
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
  await saveEditorsBeforeTrashing(TRASH_ID);
  const result = await api.trashMany(items);
  await loadTree();
  return result;
}

// ---------- Trash actions (operate on items already inside trash) ----------

/** Move a trashed note back to the folder it was deleted from. */
export async function restoreNote(id: string): Promise<void> {
  await restoreMany([{ kind: 'note', id }]);
}

/** Permanently delete a note from the database. */
export async function purgeNote(id: string): Promise<void> {
  await api.purgeNote(id);
  await loadTree();
}

/** Move a trashed folder back to the folder it was deleted from. */
export async function restoreCollection(id: string): Promise<void> {
  await restoreMany([{ kind: 'folder', id }]);
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

// ---------- Changes made in another window ----------

export interface NoteChange {
  id: string;
  title?: string;
  modified: string;
}

/**
 * Patch a note's title and `modified` stamp in place. Used for this
 * window's own saves and for those another window announces: a note
 * window keeps its own copy of the tree, so without this the main window
 * shows the old title and timestamp until it reloads.
 */
export function applyNoteChange(change: NoteChange): void {
  const existing = tree.notesById[change.id];
  if (!existing) return;
  tree.notesById[change.id] = {
    ...existing,
    ...(change.title === undefined ? {} : { title: change.title }),
    modified: change.modified
  };
  if (change.title !== undefined)
    tree.tree = renameNode(tree.tree, change.id, change.title);
}

/** Stamp `modified` after an editor saved a note, in every window. */
export function markNoteSaved(id: string): void {
  const change = { id, modified: new Date().toISOString() };
  applyNoteChange(change);
  broadcastNoteChange(change);
}

function broadcastNoteChange(change: NoteChange): void {
  // Best-effort. This window receives it too and applies the same values.
  void emit(TauriEventName.NoteSummaryChanged, change).catch((err) =>
    console.debug('[tree] note change broadcast failed', err)
  );
}

// ---------- Internal: tree patches for optimistic updates ----------

/** `nodes` with the note renamed, copying only the path to it. */
function renameNode(nodes: TreeNode[], id: string, name: string): TreeNode[] {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    let next: TreeNode | null = null;
    if (node.kind === 'note') {
      if (node.id === id) next = { ...node, name };
    } else {
      const children = renameNode(node.children, id, name);
      if (children !== node.children) next = { ...node, children };
    }
    if (next) {
      const copy = nodes.slice();
      copy[i] = next;
      return copy;
    }
  }
  return nodes;
}

/** Apply the command result without fetching every note and tag in the vault. */
// Tagged before the note reaches the tree, so it never blinks out of a
// filtered view, and before the first sync, which pushes it tagged.
async function withTags(
  note: api.Note,
  tags: readonly string[]
): Promise<api.Note> {
  if (tags.length === 0) return note;
  return api.saveNote({ id: note.id, tags: normalizeTags([...tags]) });
}

async function applyNoteSummary(note: api.Note): Promise<void> {
  const {
    body: _body,
    yrs_state: _state,
    payload_schema: _schema,
    ...summary
  } = note;
  tree.notesById[note.id] = summary;
  await finishLocalChange();
}

async function finishLocalChange(): Promise<void> {
  // Join an older read's follow-up, or recover a missing or failed snapshot.
  // `ready` only means a load attempt completed, even if it failed.
  if (inFlight || !tree.ready || tree.error !== null) {
    await loadTree();
    return;
  }
  tree.tree = composeTree(
    Object.values(tree.collectionsById),
    Object.values(tree.notesById)
  ).tree;
}
