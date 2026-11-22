import { loadNote } from '$lib/api';
import { buildInkPdf } from '$lib/notes-export/ink-pdf';
import { sanitizePdfFilename } from '$lib/pdf/filename';
import type { NoteExporter } from './types';
import { bundleExportFiles, saveExportFile } from './files';
import { tUi } from '$lib/settings/i18n.svelte';

export async function exportInkNotePdf(noteId: string): Promise<void> {
  const note = await loadNote(noteId);
  if (note.note_kind !== 'ink') {
    throw new Error('PDF export is only available for handwritten notes.');
  }

  const pdfBytes = await buildInkPdf(note.yrs_state);
  if (!pdfBytes) {
    throw new Error('Handwritten note state is unreadable.');
  }

  await saveExportFile(
    {
      format: 'pdf',
      name: `${sanitizePdfFilename(note.title)}.pdf`,
      bytes: pdfBytes
    },
    tUi('export.save.inkPdf')
  );
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
    get label() {
      return tUi('export.label.pngPages');
    },
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
