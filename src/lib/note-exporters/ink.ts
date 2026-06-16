import { loadNote } from '$lib/api';
import { saveAnnotatedPdf } from '$lib/api/pdf-export';
import { buildInkPdf } from '$lib/notes-export/ink-pdf';
import { sanitizePdfFilename } from '$lib/pdf/filename';
import type { NoteExporter } from './types';

export async function exportInkNotePdf(noteId: string): Promise<void> {
  const note = await loadNote(noteId);
  if (note.note_kind !== 'ink') {
    throw new Error('PDF export is only available for handwritten notes.');
  }

  const pdfBytes = await buildInkPdf(note.yrs_state);
  if (!pdfBytes) {
    throw new Error('Handwritten note state is unreadable.');
  }

  await saveAnnotatedPdf({
    suggestedName: `${sanitizePdfFilename(note.title)}.pdf`,
    dialogTitle: 'Save handwritten note as PDF',
    bytes: pdfBytes
  });
}

export const inkExporters: NoteExporter[] = [
  {
    id: 'ink.pdf',
    noteKind: 'ink',
    label: 'PDF',
    run: exportInkNotePdf
  }
];
