import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExcalidrawFile } from '$lib/notes-export/excalidraw';
import { freeformExporters } from './freeform';

const {
  loadNote,
  saveFileExport,
  buildExcalidrawFile,
  exportToBlob,
  exportToSvg
} = vi.hoisted(() => ({
  loadNote: vi.fn(),
  saveFileExport: vi.fn(),
  buildExcalidrawFile: vi.fn(),
  exportToBlob: vi.fn(),
  exportToSvg: vi.fn()
}));
vi.mock('$lib/api', () => ({ loadNote }));
vi.mock('$lib/api/file-export', () => ({ saveFileExport }));
vi.mock('$lib/notes-export/excalidraw', () => ({ buildExcalidrawFile }));
vi.mock('$lib/freeform/asset-path', () => ({}));
vi.mock('@excalidraw/excalidraw', () => ({ exportToBlob, exportToSvg }));

const exporter = (format: string) =>
  freeformExporters.find((entry) => entry.id === `freeform.${format}`)!;
let scene: ExcalidrawFile;

beforeEach(() => {
  vi.resetAllMocks();
  loadNote.mockResolvedValue({
    id: 'drawing',
    title: 'Sketch: draft',
    note_kind: 'freeform',
    yrs_state: [1, 2, 3]
  });
  scene = {
    type: 'excalidraw',
    version: 2,
    source: 'https://excalidraw.com',
    elements: [
      { id: 'image', type: 'image', fileId: 'stored-image' },
      { id: 'text', type: 'text', isDeleted: false },
      { id: 'deleted', type: 'text', isDeleted: true }
    ],
    appState: {
      viewBackgroundColor: '#eeeeee',
      exportWithDarkMode: true,
      exportBackground: false,
      exportEmbedScene: true
    },
    files: {
      'stored-image': { dataURL: 'data:image/png;base64,iVBORw==' }
    }
  };
  buildExcalidrawFile.mockResolvedValue(scene);
  saveFileExport.mockResolvedValue(true);
  exportToBlob.mockResolvedValue(new Blob([new Uint8Array([137, 80, 78, 71])]));
  exportToSvg.mockResolvedValue({ outerHTML: '<svg><image /></svg>' });
});

describe('freeform exports', () => {
  it('saves an editable scene with embedded files and deleted elements intact', async () => {
    await exporter('excalidraw').run('drawing');
    expect(loadNote).toHaveBeenCalledWith('drawing');
    expect(buildExcalidrawFile).toHaveBeenCalledWith([1, 2, 3]);
    expect(saveFileExport).toHaveBeenCalledOnce();
    const file = saveFileExport.mock.calls[0][0];
    expect(file).toMatchObject({
      suggestedName: 'Sketch draft.excalidraw',
      mime: 'application/json',
      extensions: ['excalidraw']
    });
    expect(JSON.parse(new TextDecoder().decode(file.bytes))).toEqual(scene);
    expect(exportToBlob).not.toHaveBeenCalled();
    expect(exportToSvg).not.toHaveBeenCalled();
  });

  it.each(['png', 'svg'])(
    'renders %s with images, a light background and only visible elements',
    async (format) => {
      await exporter(format).run('drawing');
      const renderer = format === 'png' ? exportToBlob : exportToSvg;
      expect(renderer).toHaveBeenCalledWith({
        elements: scene.elements.slice(0, 2),
        appState: {
          viewBackgroundColor: '#eeeeee',
          exportWithDarkMode: false,
          exportBackground: true,
          exportEmbedScene: false
        },
        files: scene.files,
        ...(format === 'png' ? { mimeType: 'image/png' } : {})
      });
      expect(saveFileExport).toHaveBeenCalledOnce();
      expect(saveFileExport.mock.calls[0][0]).toMatchObject({
        suggestedName: `Sketch draft.${format}`,
        extensions: [format],
        mime: format === 'png' ? 'image/png' : 'image/svg+xml',
        bytes:
          format === 'png'
            ? new Uint8Array([137, 80, 78, 71])
            : new TextEncoder().encode('<svg><image /></svg>')
      });
      expect(scene.elements).toHaveLength(3);
      expect(scene.appState.exportWithDarkMode).toBe(true);
    }
  );

  it('writes a valid empty scene for a new drawing', async () => {
    buildExcalidrawFile.mockResolvedValue(null);
    await exporter('excalidraw').run('drawing');
    const file = saveFileExport.mock.calls[0][0];
    expect(JSON.parse(new TextDecoder().decode(file.bytes))).toEqual({
      type: 'excalidraw',
      version: 2,
      source: 'https://excalidraw.com',
      elements: [],
      appState: {},
      files: {}
    });
  });

  it.each(['excalidraw', 'png', 'svg'])(
    'rejects a different note kind before attempting a %s export',
    async (format) => {
      loadNote.mockResolvedValue({ note_kind: 'markdown' });
      await expect(exporter(format).run('drawing')).rejects.toThrow(
        'only available for freeform notes'
      );
      expect(buildExcalidrawFile).not.toHaveBeenCalled();
      expect(saveFileExport).not.toHaveBeenCalled();
    }
  );

  it.each(['excalidraw', 'png', 'svg'])(
    'does not save an incomplete %s export when scene loading fails',
    async (format) => {
      const error = new Error('Stored image is unavailable');
      buildExcalidrawFile.mockRejectedValue(error);
      await expect(exporter(format).run('drawing')).rejects.toBe(error);
      expect(exportToBlob).not.toHaveBeenCalled();
      expect(exportToSvg).not.toHaveBeenCalled();
      expect(saveFileExport).not.toHaveBeenCalled();
    }
  );

  it.each(['png', 'svg'])(
    'does not save a %s file when rendering fails',
    async (format) => {
      const error = new Error('Rendering failed');
      const renderer = format === 'png' ? exportToBlob : exportToSvg;
      renderer.mockRejectedValue(error);
      await expect(exporter(format).run('drawing')).rejects.toBe(error);
      expect(saveFileExport).not.toHaveBeenCalled();
    }
  );
});
