import { loadNote } from '$lib/api';
import { saveAnnotatedPdf } from '$lib/api/pdf-export';
import { buildInkPdf } from '$lib/notes-export/ink-pdf';
import { sanitizePdfFilename } from '$lib/pdf/filename';
import type { NoteExporter } from './types';
import { bundleExportFiles, saveExportFile } from './files';

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
  },
  {
    id: 'ink.png',
    noteKind: 'ink',
    label: 'PNG pages',
    run: async (noteId) => {
      const note = await loadNote(noteId);
      if (note.note_kind !== 'ink')
        throw new Error('PNG export is only available for handwritten notes.');
      const bytes = await buildInkPdf(note.yrs_state);
      if (!bytes) throw new Error('Handwritten note state is unreadable.');
      const { pdfPngFiles } = await import('./pdf-images');
      await saveExportFile(
        await bundleExportFiles(
          note.title,
          await pdfPngFiles(bytes, note.title)
        )
      );
    }
  }
];
