import { loadNote } from '$lib/api';
import { renderMarkdownFile } from '$lib/notes-export/markdown';
import { exportFilename, saveExportFile, textFile } from './files';
import type { NoteExporter } from './types';

export const markdownExporters: NoteExporter[] = (
  ['md', 'html', 'pdf', 'docx'] as const
).map((format) => ({
  id: `markdown.${format}`,
  noteKind: 'markdown',
  label: { md: 'Markdown', html: 'HTML', pdf: 'PDF', docx: 'Word' }[format],
  run: async (noteId) => {
    const note = await loadNote(noteId);
    if (note.note_kind !== 'markdown')
      throw new Error('This export is only available for Markdown notes.');
    const { inlineNoteAssets, parseDocument, documentHtml } =
      await import('./document');
    if (format === 'md') {
      await saveExportFile(
        textFile(
          note.title,
          format,
          renderMarkdownFile(note, await inlineNoteAssets(note.body))
        )
      );
      return;
    }
    const doc = await parseDocument(note);
    if (format === 'html') {
      await saveExportFile(
        textFile(note.title, format, await documentHtml(doc))
      );
      return;
    }
    const bytes =
      format === 'pdf'
        ? await (await import('./markdown-pdf')).documentPdf(doc)
        : await (await import('./markdown-docx')).documentDocx(doc);
    await saveExportFile({
      name: exportFilename(note.title, format),
      bytes,
      format
    });
  }
}));
