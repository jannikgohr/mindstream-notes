/**
 * Notes API. Mirror of src-tauri/src/notes/mod.rs.
 *
 * Bodies are lazy: list_notes returns summaries (no body); load_note
 * fetches the full note + body on demand. Soft-delete via trash_note.
 */

import {
  assertBoolean,
  assertNumber,
  assertNumberArray,
  assertRecord,
  assertString,
  assertStringArray,
  assertVoid,
  invokeOrFallback,
  optionalString
} from './core';
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
export enum NoteKindEnum {
  Markdown = 'markdown',
  Freeform = 'freeform',
  Ink = 'ink',
  Pdf = 'pdf',
  Kanban = 'kanban'
}

export type NoteKind = `${NoteKindEnum}`;

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
  NoteKindEnum.Markdown,
  NoteKindEnum.Freeform,
  NoteKindEnum.Ink,
  NoteKindEnum.Pdf,
  NoteKindEnum.Kanban
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

function assertNoteKind(value: unknown, context: string): NoteKind {
  const kind = assertString(value, context);
  if (!isKnownNoteKind(kind))
    throw new Error(`${context} is not a known note kind`);
  return kind;
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
  return invokeOrFallback<NoteSummary[]>(
    'list_notes',
    { includeTrashed },
    () => mockApi.listNotes(includeTrashed),
    parseNoteSummaries
  );
}

export function loadNote(id: string): Promise<Note> {
  assertNonEmptyString(id, 'loadNote.id');
  return invokeOrFallback<Note>(
    'load_note',
    { id },
    () => mockApi.loadNote(id),
    parseNote
  );
}

export function createNote(input: CreateNoteInput): Promise<Note> {
  assertCreateNoteInput(input);
  return invokeOrFallback<Note>(
    'create_note',
    { input },
    () => mockApi.createNote(input),
    parseNote
  );
}

export function saveNote(input: UpdateNoteInput): Promise<Note> {
  assertUpdateNoteInput(input);
  return invokeOrFallback<Note>(
    'save_note',
    { input },
    () => mockApi.saveNote(input),
    parseNote
  );
}

export function trashNote(id: string): Promise<void> {
  assertNonEmptyString(id, 'trashNote.id');
  return invokeOrFallback<void>(
    'trash_note',
    { id },
    () => mockApi.trashNote(id),
    (value) => assertVoid(value, 'trash_note response')
  );
}

export function restoreNote(id: string): Promise<void> {
  assertNonEmptyString(id, 'restoreNote.id');
  return invokeOrFallback<void>(
    'restore_note',
    { id },
    () => mockApi.restoreNote(id),
    (value) => assertVoid(value, 'restore_note response')
  );
}

export function purgeNote(id: string): Promise<void> {
  assertNonEmptyString(id, 'purgeNote.id');
  return invokeOrFallback<void>(
    'purge_note',
    { id },
    () => mockApi.purgeNote(id),
    (value) => assertVoid(value, 'purge_note response')
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

function assertNonEmptyString(value: string, context: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${context} must be a non-empty string`);
  }
}

function assertCreateNoteInput(input: CreateNoteInput): void {
  if (input.title !== undefined && typeof input.title !== 'string') {
    throw new Error('CreateNoteInput.title must be a string');
  }
  if (input.body !== undefined && typeof input.body !== 'string') {
    throw new Error('CreateNoteInput.body must be a string');
  }
  if (
    input.parent_collection_id !== undefined &&
    input.parent_collection_id !== null &&
    typeof input.parent_collection_id !== 'string'
  ) {
    throw new Error(
      'CreateNoteInput.parent_collection_id must be a string or null'
    );
  }
  if (input.note_kind !== undefined && !isKnownNoteKind(input.note_kind)) {
    throw new Error('CreateNoteInput.note_kind is not a known note kind');
  }
}

function assertUpdateNoteInput(input: UpdateNoteInput): void {
  assertNonEmptyString(input.id, 'UpdateNoteInput.id');
  if (input.title !== undefined && typeof input.title !== 'string') {
    throw new Error('UpdateNoteInput.title must be a string');
  }
  if (input.body !== undefined && typeof input.body !== 'string') {
    throw new Error('UpdateNoteInput.body must be a string');
  }
  if (
    input.parent_collection_id !== undefined &&
    input.parent_collection_id !== null &&
    typeof input.parent_collection_id !== 'string'
  ) {
    throw new Error(
      'UpdateNoteInput.parent_collection_id must be a string or null'
    );
  }
  if (input.position !== undefined && !Number.isFinite(input.position)) {
    throw new Error('UpdateNoteInput.position must be finite');
  }
  if (input.tags !== undefined && !Array.isArray(input.tags)) {
    throw new Error('UpdateNoteInput.tags must be an array');
  }
  if (input.yrs_state !== undefined && !Array.isArray(input.yrs_state)) {
    throw new Error('UpdateNoteInput.yrs_state must be an array');
  }
  if (input.favourite !== undefined && typeof input.favourite !== 'boolean') {
    throw new Error('UpdateNoteInput.favourite must be a boolean');
  }
}

export function parseNoteSummary(value: unknown): NoteSummary {
  const raw = assertRecord(value, 'NoteSummary');
  return {
    id: assertString(raw.id, 'NoteSummary.id'),
    parent_collection_id: optionalString(
      raw.parent_collection_id,
      'NoteSummary.parent_collection_id'
    ),
    title: assertString(raw.title, 'NoteSummary.title'),
    position: assertNumber(raw.position, 'NoteSummary.position'),
    created: assertString(raw.created, 'NoteSummary.created'),
    modified: assertString(raw.modified, 'NoteSummary.modified'),
    tags: assertStringArray(raw.tags, 'NoteSummary.tags'),
    trashed: assertBoolean(raw.trashed, 'NoteSummary.trashed'),
    favourite: assertBoolean(raw.favourite, 'NoteSummary.favourite'),
    pushed: assertBoolean(raw.pushed, 'NoteSummary.pushed'),
    note_kind: assertNoteKind(raw.note_kind, 'NoteSummary.note_kind')
  };
}

export function parseNote(value: unknown): Note {
  const raw = assertRecord(value, 'Note');
  return {
    ...parseNoteSummary(raw),
    body: assertString(raw.body, 'Note.body'),
    yrs_state: assertNumberArray(raw.yrs_state, 'Note.yrs_state'),
    payload_schema: assertNumber(raw.payload_schema, 'Note.payload_schema')
  };
}

function parseNoteSummaries(value: unknown): NoteSummary[] {
  if (!Array.isArray(value)) throw new Error('NoteSummary[] must be an array');
  return value.map(parseNoteSummary);
}
