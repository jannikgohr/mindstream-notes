/**
 * Content statistics API. Mirror of src-tauri/src/content_stats.rs.
 *
 * The word count is computed in Rust from the note's DB content (markdown
 * `body`, or `pdf_text` for PDFs) so the sidebar's "Words" stat and the History
 * "+N / −M words" delta share one definition and never drift — and note content
 * isn't shipped over IPC just to count it.
 */

import { assertNumber, TauriCommandName, invokeOrFallback } from './core';
import { mockApi } from './mock-store';

export function noteWordCount(noteId: string): Promise<number> {
  return invokeOrFallback<number>(
    TauriCommandName.NoteWordCount,
    { noteId },
    () => mockApi.noteWordCount(noteId),
    (value) => assertNumber(value, 'note_word_count response')
  );
}
