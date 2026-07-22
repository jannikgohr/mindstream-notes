/**
 * PDF searchable-text index API. Mirror of src-tauri/src/pdf_text.rs.
 *
 * A PDF note's bytes are immutable, so its extracted text is derived data we
 * compute once (via pdf.js — see `$lib/pdf/extract-text`) and cache in the
 * `notes.pdf_text` column so the cross-note search can hit PDF content. The
 * column is local-only/derived (never synced); writing it never dirties the
 * note. Population is driven from the frontend:
 *
 *   - `setPdfText`        persists extracted text (idempotent on the Rust side).
 *   - `pdfNotesMissingText` lists un-indexed PDFs for the background sweep.
 *   - `pdfNoteNeedsText`   cheap per-note gate for the viewer's on-open path.
 */

import {
  assertBoolean,
  assertStringArray,
  assertVoid,
  TauriCommandName,
  invokeOrFallback
} from './core';
import { mockApi } from './mock-store';

export function setPdfText(noteId: string, text: string): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.SetPdfText,
    { noteId, text },
    () => mockApi.setPdfText(noteId, text),
    (value) => assertVoid(value, 'set_pdf_text response')
  );
}

export function pdfNotesMissingText(): Promise<string[]> {
  return invokeOrFallback<string[]>(
    TauriCommandName.PdfNotesMissingText,
    undefined,
    () => mockApi.pdfNotesMissingText(),
    (value) => assertStringArray(value, 'pdf_notes_missing_text response')
  );
}

export function pdfNoteNeedsText(noteId: string): Promise<boolean> {
  return invokeOrFallback<boolean>(
    TauriCommandName.PdfNoteNeedsText,
    { noteId },
    () => mockApi.pdfNoteNeedsText(noteId),
    (value) => assertBoolean(value, 'pdf_note_needs_text response')
  );
}
