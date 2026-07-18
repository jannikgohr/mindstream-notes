/**
 * Notes API. Mirror of src-tauri/src/notes/mod.rs.
 *
 * Bodies are lazy: list_notes returns summaries (no body); load_note
 * fetches the full note + body on demand. Soft-delete via trash_note.
 */

import { invokeOrFallback } from './core';
import { mockApi } from './mock-store';

/**
 * Editor-kind discriminator. The frontend uses this to pick which editor
 * component to render for a given note. Add a new value here AND on the
 * Rust side (notes::default_note_kind / NotePayload.note_kind) when
 * introducing a new editor variant.
 *
 *   markdown — Crepe / y-prosemirror text editor (the original kind)
 *   freeform — Excalidraw canvas backed by granular Y.Doc scene state
 *   ink      — native egui+wgpu drawing surface (Android-only POC; see
 *              docs/native-egui-layer/01-audit.md). Desktop dispatch
 *              shows a placeholder until Phase 2 lands.
 *   pdf      — imported PDF binary stored as an app-owned asset, with
 *              yrs_state reserved for collaborative annotations.
 *   kanban   — SVAR Kanban board whose columns/cards live directly in the
 *              note's Y.Doc (yrs_state), synced like any collaborative doc.
 */
export type NoteKind = 'markdown' | 'freeform' | 'ink' | 'pdf' | 'kanban';

/**
 * The full set of editor kinds this app version knows how to render.
 * If a synced note arrives with a kind not in this list — typically
 * because a newer app version on another device introduced it —
 * dispatch sites render `UnknownNoteKindError` instead of silently
 * falling back to the markdown editor, which would corrupt the
 * note's `body` on the next save.
 *
 * Keep this in sync with the `NoteKind` union above and with the
 * matching `default_note_kind` / supported list in
 * src-tauri/src/notes/mod.rs.
 */
export const KNOWN_NOTE_KINDS = [
  'markdown',
  'freeform',
  'ink',
  'pdf',
  'kanban'
] as const;

/** Narrows an arbitrary string (e.g. from a remote-synced row) into
 *  the typed `NoteKind` union. */
export function isKnownNoteKind(
  kind: string | undefined | null
): kind is NoteKind {
  return (
    typeof kind === 'string' &&
    (KNOWN_NOTE_KINDS as readonly string[]).includes(kind)
  );
}

export interface NoteSummary {
  id: string;
  parent_collection_id: string | null;
  title: string;
  position: number;
  created: string;
  modified: string;
  tags: string[];
  trashed: boolean;
  favourite: boolean;
  /**
   * True once the note has been pushed to the remote at least once
   * (i.e. it has an etebase Item UID). NoteEditor watches this to
   * (re-)attach the live-collab provider as soon as a freshly-created
   * note's first sync completes.
   */
  pushed: boolean;
  /**
   * Editor-kind discriminator. Lives on the summary (not just the full
   * note) so dispatch / file-tree icons can branch without loading the
   * body. Defaults to 'markdown' for old data that pre-dates the column.
   */
  note_kind: NoteKind;
}

export interface Note extends NoteSummary {
  body: string;
  /**
   * Encoded yjs Doc state. Empty for never-edited notes. The editor
   * applies this to its y-prosemirror Doc on open. Carried as a JSON
   * number array — wasteful for large docs but avoids a base64 hop.
   */
  yrs_state: number[];
  /** 1 = legacy Y.Text, 2 = y-prosemirror XmlFragment (current). */
  payload_schema: number;
}

export interface CreateNoteInput {
  title?: string;
  body?: string;
  parent_collection_id?: string | null;
  /** Defaults to 'markdown' server-side when omitted. */
  note_kind?: NoteKind;
}

export interface UpdateNoteInput {
  id: string;
  title?: string;
  body?: string;
  /**
   * Set to `null` to move to root, omit to leave parent unchanged.
   * (The Rust side sees this as Option<Option<String>>.)
   */
  parent_collection_id?: string | null;
  position?: number;
  tags?: string[];
  /**
   * When the live editor is the source of truth, it ships its computed
   * yjs state alongside the rendered markdown so Rust skips the
   * markdown-diff path. Presence of this field also flips the row's
   * payload_schema to 2 (see src-tauri/src/notes/mod.rs::update).
   */
  yrs_state?: number[];
  favourite?: boolean;
}

export function listNotes(includeTrashed = false): Promise<NoteSummary[]> {
  return invokeOrFallback<NoteSummary[]>('list_notes', { includeTrashed }, () =>
    mockApi.listNotes(includeTrashed)
  );
}

export function loadNote(id: string): Promise<Note> {
  return invokeOrFallback<Note>('load_note', { id }, () =>
    mockApi.loadNote(id)
  );
}

export function createNote(input: CreateNoteInput): Promise<Note> {
  return invokeOrFallback<Note>('create_note', { input }, () =>
    mockApi.createNote(input)
  );
}

export function saveNote(input: UpdateNoteInput): Promise<Note> {
  return invokeOrFallback<Note>('save_note', { input }, () =>
    mockApi.saveNote(input)
  );
}

export function trashNote(id: string): Promise<void> {
  return invokeOrFallback<void>('trash_note', { id }, () =>
    mockApi.trashNote(id)
  );
}

export function restoreNote(id: string): Promise<void> {
  return invokeOrFallback<void>('restore_note', { id }, () =>
    mockApi.restoreNote(id)
  );
}

export function purgeNote(id: string): Promise<void> {
  return invokeOrFallback<void>('purge_note', { id }, () =>
    mockApi.purgeNote(id)
  );
}

/**
 * Back-compat: the old callsites passed { id, title, body }. Map it onto
 * the new UpdateNoteInput shape so existing code continues to compile.
 */
export interface LegacyNotePayload {
  id: string;
  title: string;
  body: string;
}
