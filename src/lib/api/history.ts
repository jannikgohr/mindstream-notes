/**
 * Note history API. Mirror of src-tauri/src/history/mod.rs.
 *
 * History is a local, automatic per-note timeline of compressed markdown
 * snapshots — never synced (each device keeps its own), but a *restore*
 * converges across devices because the editor applies it as a normal CRDT
 * edit. Capture is driven from the editor (idle debounce + on close + on
 * create/restore); the backend dedups and caps.
 */

import { invokeOrFallback } from './core';
import { mockApi } from './mock-store';

/** Why a version exists. Room for `imported` | `manual` later. */
export type VersionAction = 'created' | 'edited' | 'reverted';

export interface VersionSummary {
  id: string;
  note_id: string;
  created: string;
  note_kind: string;
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
  /** Uncompressed markdown byte length. */
  size: number;
}

export interface Version extends VersionSummary {
  /** Decompressed markdown snapshot. */
  body: string;
}

/**
 * Capture a snapshot of `markdown` for a note. Returns the new version, or
 * `null` when it was a no-op (unchanged since the last version). The backend
 * promotes a note's first version to `action: 'created'`.
 */
export function captureNoteVersion(
  noteId: string,
  noteKind: string,
  action: VersionAction,
  markdown: string,
  refVersionId: string | null = null
): Promise<VersionSummary | null> {
  return invokeOrFallback<VersionSummary | null>(
    'capture_note_version',
    { noteId, noteKind, action, refVersionId, markdown },
    () =>
      mockApi.captureNoteVersion(
        noteId,
        noteKind,
        action,
        markdown,
        refVersionId
      )
  );
}

export function listNoteVersions(noteId: string): Promise<VersionSummary[]> {
  return invokeOrFallback<VersionSummary[]>(
    'list_note_versions',
    { noteId },
    () => mockApi.listNoteVersions(noteId)
  );
}

export function loadNoteVersion(versionId: string): Promise<Version> {
  return invokeOrFallback<Version>('load_note_version', { versionId }, () =>
    mockApi.loadNoteVersion(versionId)
  );
}

/** Delete versions older than `retentionDays`. `null` = keep forever. */
export function pruneNoteVersions(
  retentionDays: number | null
): Promise<number> {
  return invokeOrFallback<number>(
    'prune_note_versions',
    { retentionDays },
    () => mockApi.pruneNoteVersions(retentionDays)
  );
}
