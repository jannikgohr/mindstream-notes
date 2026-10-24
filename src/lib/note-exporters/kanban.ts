import { loadNote } from '$lib/api';
import { tree } from '$lib/stores/tree.svelte';
import {
  boardCsv,
  boardMarkdown,
  boardXlsx,
  readExportBoard
} from '$lib/notes-export/kanban';
import { exportFilename, saveExportFile, textFile } from './files';
import type { NoteExporter } from './types';

export const kanbanExporters: NoteExporter[] = (
  ['csv', 'xlsx', 'md', 'json'] as const
).map((format) => ({
  id: `kanban.${format}`,
  noteKind: 'kanban',
  label: { csv: 'CSV', xlsx: 'Excel', md: 'Markdown', json: 'JSON' }[format],
  run: async (noteId) => {
    const note = await loadNote(noteId);
    if (note.note_kind !== 'kanban')
      throw new Error('This export is only available for Kanban boards.');
    const board = readExportBoard(note.yrs_state);
    const titles = Object.fromEntries(
      Object.values(tree.notesById).map((entry) => [entry.id, entry.title])
    );
    if (format === 'xlsx') {
      await saveExportFile({
        name: exportFilename(note.title, format),
        format,
        bytes: await boardXlsx(board, titles)
      });
    } else {
      const content =
        format === 'csv'
          ? boardCsv(board, titles)
          : format === 'md'
            ? boardMarkdown(board)
            : JSON.stringify(board, null, 2);
      const body =
        format === 'md'
          ? await (await import('./document')).inlineNoteAssets(content)
          : content;
      await saveExportFile(textFile(note.title, format, body));
    }
  }
}));
