import { loadNote } from '$lib/api';
import { exportFilename, saveExportFile, textFile } from './files';
import type { NoteExporter } from './types';

export const freeformExporters: NoteExporter[] = (
  ['excalidraw', 'png', 'svg'] as const
).map((format) => ({
  id: `freeform.${format}`,
  noteKind: 'freeform',
  label: { excalidraw: 'Excalidraw', png: 'PNG', svg: 'SVG' }[format],
  run: async (noteId) => {
    const note = await loadNote(noteId);
    if (note.note_kind !== 'freeform')
      throw new Error('This export is only available for freeform notes.');
    await import('$lib/freeform/asset-path');
    const { buildExcalidrawFile } =
      await import('$lib/notes-export/excalidraw');
    const scene = (await buildExcalidrawFile(note.yrs_state)) ?? {
      type: 'excalidraw',
      version: 2,
      source: 'https://excalidraw.com',
      elements: [],
      appState: {},
      files: {}
    };
    if (format === 'excalidraw') {
      await saveExportFile(
        textFile(note.title, format, JSON.stringify(scene, null, 2))
      );
      return;
    }
    const { exportToBlob, exportToSvg } =
      await import('@excalidraw/excalidraw');
    const options = {
      elements: scene.elements.filter(
        (element) => !(element as { isDeleted?: boolean }).isDeleted
      ) as import('@excalidraw/excalidraw/element/types').NonDeletedExcalidrawElement[],
      appState: {
        ...scene.appState,
        exportBackground: true,
        exportWithDarkMode: false,
        exportEmbedScene: false
      },
      files: scene.files as import('@excalidraw/excalidraw/types').BinaryFiles
    };
    if (format === 'svg') {
      const svg = await exportToSvg(options);
      await saveExportFile(textFile(note.title, format, svg.outerHTML));
    } else {
      const blob = await exportToBlob({ ...options, mimeType: 'image/png' });
      await saveExportFile({
        name: exportFilename(note.title, format),
        format,
        bytes: new Uint8Array(await blob.arrayBuffer())
      });
    }
  }
}));
