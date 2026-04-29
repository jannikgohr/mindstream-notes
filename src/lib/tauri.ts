/**
 * Back-compat shim. The typed bridge has moved to `$lib/api/`. New code
 * should import from there directly; existing imports of saveNote /
 * loadNote / openNoteWindow keep working through these re-exports.
 */

export { isTauri, saveNote, loadNote, listNotes, openNoteWindow } from './api';
export type { Note, NoteSummary } from './api';
