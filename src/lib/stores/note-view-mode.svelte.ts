/**
 * Per-note editor view-mode control (WYSIWYG / Source / Split), published by
 * the editor so chrome outside it can render the toggle.
 *
 * On mobile the toggle lives in the note header next to the title, status
 * icons and favourite star. Inside the editor it would need a row of its own:
 * formatting sits in the floating pill there, so nothing else shares the line.
 *
 * Same shape as `note-status`: the editor owns the lifecycle (publishes while
 * mounted, clears on destroy) and the header reads by note id. The header
 * can't reach the editor any other way, because `NoteKindRenderer` sits
 * between them.
 */

import type { EditorViewMode } from '$lib/editor/source/view-mode';

export interface NoteViewModeControl {
  value: EditorViewMode;
  /** Advance to the next view mode. */
  onCycle: () => void;
}

export const noteViewMode = $state<Record<string, NoteViewModeControl>>({});

export function setNoteViewMode(noteId: string, control: NoteViewModeControl) {
  noteViewMode[noteId] = control;
}

export function clearNoteViewMode(noteId: string) {
  delete noteViewMode[noteId];
}

/** The control for a note id, or `null` when its editor publishes none (not
 *  mounted yet, not ready, or a note kind without view modes). */
export function getNoteViewMode(
  noteId: string | null | undefined
): NoteViewModeControl | null {
  if (!noteId) return null;
  return noteViewMode[noteId] ?? null;
}
