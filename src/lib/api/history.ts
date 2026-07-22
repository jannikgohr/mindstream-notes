/**
 * Note history API. Mirror of src-tauri/src/history/mod.rs.
 *
 * History is a local, automatic per-note timeline of compressed snapshots —
 * never synced (each device keeps its own), but a *restore* converges across
 * devices because the editor applies it as normal current note state. Capture
 * is driven from the editor (idle debounce + on close + on create/restore);
 * the backend dedups and caps.
 */

import {
  assertNumber,
  assertRecord,
  assertString,
  TauriCommandName,
  invokeOrFallback,
  optionalString
} from './core';
import { mockApi } from './mock-store';
import { isKnownNoteKind, type NoteKind } from './notes';

/** Why a version exists. Room for `imported` | `manual` later. */
export enum VersionActionEnum {
  Created = 'created',
  Edited = 'edited',
  Reverted = 'reverted'
}

export type VersionAction = `${VersionActionEnum}`;

export interface VersionSummary {
  id: string;
  note_id: string;
  created: string;
  note_kind: NoteKind;
  action: VersionAction;
  /** Future user-named bookmark; null for now. */
  label: string | null;
  /** Restore target's version id (action === 'reverted'). */
  ref_version_id: string | null;
  /** Restore target's timestamp, kept for display after the target is pruned. */
  ref_created: string | null;
  words_added: number;
  words_removed: number;
  /**
   * Fallback magnitude for word-neutral edits: non-whitespace characters
   * added/removed vs the previous snapshot (formatting, punctuation, …).
   */
  tokens_added: number;
  tokens_removed: number;
  /** Uncompressed snapshot byte length. */
  size: number;
}

export interface Version extends VersionSummary {
  /** Decompressed snapshot payload. Markdown is raw text; other kinds may wrap. */
  body: string;
}

/**
 * Capture a snapshot payload for a note. Returns the new version, or
 * `null` when it was a no-op (unchanged since the last version). The backend
 * promotes a note's first version to `action: 'created'`.
 */
export function captureNoteVersion(
  noteId: string,
  noteKind: NoteKind,
  action: VersionAction,
  snapshot: string,
  refVersionId: string | null = null
): Promise<VersionSummary | null> {
  assertNonEmptyString(noteId, 'captureNoteVersion.noteId');
  assertNoteKind(noteKind, 'captureNoteVersion.noteKind');
  assertVersionAction(action, 'captureNoteVersion.action');
  assertString(snapshot, 'captureNoteVersion.snapshot');
  return invokeOrFallback<VersionSummary | null>(
    TauriCommandName.CaptureNoteVersion,
    { noteId, noteKind, action, refVersionId, markdown: snapshot },
    () =>
      mockApi.captureNoteVersion(
        noteId,
        noteKind,
        action,
        snapshot,
        refVersionId
      ),
    parseOptionalVersionSummary
  );
}

/**
 * Capture the note's latest saved state on the backend. For non-markdown notes
 * this avoids encoding a large live Yjs document on the UI thread; editors
 * should flush their normal save path first.
 */
export function captureCurrentNoteVersion(
  noteId: string,
  action: VersionAction,
  refVersionId: string | null = null
): Promise<VersionSummary | null> {
  assertNonEmptyString(noteId, 'captureCurrentNoteVersion.noteId');
  assertVersionAction(action, 'captureCurrentNoteVersion.action');
  return invokeOrFallback<VersionSummary | null>(
    TauriCommandName.CaptureCurrentNoteVersion,
    { noteId, action, refVersionId },
    () => mockApi.captureCurrentNoteVersion(noteId, action, refVersionId),
    parseOptionalVersionSummary
  );
}

export function listNoteVersions(noteId: string): Promise<VersionSummary[]> {
  assertNonEmptyString(noteId, 'listNoteVersions.noteId');
  return invokeOrFallback<VersionSummary[]>(
    TauriCommandName.ListNoteVersions,
    { noteId },
    () => mockApi.listNoteVersions(noteId),
    parseVersionSummaries
  );
}

export function loadNoteVersion(versionId: string): Promise<Version> {
  assertNonEmptyString(versionId, 'loadNoteVersion.versionId');
  return invokeOrFallback<Version>(
    TauriCommandName.LoadNoteVersion,
    { versionId },
    () => mockApi.loadNoteVersion(versionId),
    parseVersion
  );
}

/** Delete versions older than `retentionDays`. `null` = keep forever. */
export function pruneNoteVersions(
  retentionDays: number | null
): Promise<number> {
  if (retentionDays !== null && !Number.isFinite(retentionDays)) {
    throw new Error('retentionDays must be null or finite');
  }
  return invokeOrFallback<number>(
    TauriCommandName.PruneNoteVersions,
    { retentionDays },
    () => mockApi.pruneNoteVersions(retentionDays),
    (value) => assertNumber(value, 'prune_note_versions')
  );
}

function assertNonEmptyString(value: string, context: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${context} must be a non-empty string`);
  }
}

function assertNoteKind(
  value: unknown,
  context: string
): asserts value is NoteKind {
  if (typeof value !== 'string' || !isKnownNoteKind(value)) {
    throw new Error(`${context} is not a known note kind`);
  }
}

function assertVersionAction(
  value: unknown,
  context: string
): asserts value is VersionAction {
  if (
    value !== VersionActionEnum.Created &&
    value !== VersionActionEnum.Edited &&
    value !== VersionActionEnum.Reverted
  ) {
    throw new Error(`${context} is not a known version action`);
  }
}

function parseVersionAction(value: unknown): VersionAction {
  assertVersionAction(value, 'VersionSummary.action');
  return value;
}

function parseNoteKind(value: unknown): NoteKind {
  assertNoteKind(value, 'VersionSummary.note_kind');
  return value;
}

function parseVersionSummary(value: unknown): VersionSummary {
  const raw = assertRecord(value, 'VersionSummary');
  return {
    id: assertString(raw.id, 'VersionSummary.id'),
    note_id: assertString(raw.note_id, 'VersionSummary.note_id'),
    created: assertString(raw.created, 'VersionSummary.created'),
    note_kind: parseNoteKind(raw.note_kind),
    action: parseVersionAction(raw.action),
    label: optionalString(raw.label, 'VersionSummary.label'),
    ref_version_id: optionalString(
      raw.ref_version_id,
      'VersionSummary.ref_version_id'
    ),
    ref_created: optionalString(raw.ref_created, 'VersionSummary.ref_created'),
    words_added: assertNumber(raw.words_added, 'VersionSummary.words_added'),
    words_removed: assertNumber(
      raw.words_removed,
      'VersionSummary.words_removed'
    ),
    tokens_added: assertNumber(raw.tokens_added, 'VersionSummary.tokens_added'),
    tokens_removed: assertNumber(
      raw.tokens_removed,
      'VersionSummary.tokens_removed'
    ),
    size: assertNumber(raw.size, 'VersionSummary.size')
  };
}

function parseOptionalVersionSummary(value: unknown): VersionSummary | null {
  return value === null ? null : parseVersionSummary(value);
}

function parseVersionSummaries(value: unknown): VersionSummary[] {
  if (!Array.isArray(value))
    throw new Error('VersionSummary[] must be an array');
  return value.map(parseVersionSummary);
}

function parseVersion(value: unknown): Version {
  const raw = assertRecord(value, 'Version');
  return {
    ...parseVersionSummary(raw),
    body: assertString(raw.body, 'Version.body')
  };
}
