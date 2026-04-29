/**
 * Notes API. Mirror of src-tauri/src/notes/mod.rs.
 *
 * Bodies are lazy: list_notes returns summaries (no body); load_note
 * fetches the full note + body on demand. Soft-delete via trash_note.
 */

import { invokeOrFallback } from './index';
import { mockApi } from './mock-store';

export interface NoteSummary {
  id: string;
  parent_collection_id: string | null;
  title: string;
  position: number;
  created: string;
  modified: string;
  tags: string[];
  trashed: boolean;
}

export interface Note extends NoteSummary {
  body: string;
}

export interface CreateNoteInput {
  title?: string;
  body?: string;
  parent_collection_id?: string | null;
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
}

export function listNotes(includeTrashed = false): Promise<NoteSummary[]> {
  return invokeOrFallback<NoteSummary[]>(
    'list_notes',
    { includeTrashed },
    () => mockApi.listNotes(includeTrashed)
  );
}

export function loadNote(id: string): Promise<Note> {
  return invokeOrFallback<Note>('load_note', { id }, () => mockApi.loadNote(id));
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
  return invokeOrFallback<void>('trash_note', { id }, () => mockApi.trashNote(id));
}

export function restoreNote(id: string): Promise<void> {
  return invokeOrFallback<void>('restore_note', { id }, () =>
    mockApi.restoreNote(id)
  );
}

export function purgeNote(id: string): Promise<void> {
  return invokeOrFallback<void>('purge_note', { id }, () => mockApi.purgeNote(id));
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
