import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { strFromU8, unzipSync } from 'fflate';
import { markdownExporters } from './markdown';

const { loadNote, saveFileExport, fetchDrawingAsset } = vi.hoisted(() => ({
  loadNote: vi.fn(),
  saveFileExport: vi.fn(),
  fetchDrawingAsset: vi.fn()
}));
vi.mock('$lib/api', () => ({ loadNote }));
vi.mock('$lib/api/file-export', () => ({ saveFileExport }));
vi.mock('$lib/api/assets', () => ({ fetchDrawingAsset }));

const note = {
  id: 'note-1',
  title: 'Report: draft',
  note_kind: 'markdown',
  body: '# Results\n\nA **useful** result.',
  created: '2026-10-22T09:00:00Z',
  modified: '2026-10-22T10:00:00Z',
  tags: ['research'],
  favourite: true
};

beforeEach(() => {
  vi.resetAllMocks();
  loadNote.mockResolvedValue(note);
  saveFileExport.mockResolvedValue(true);
  fetchDrawingAsset.mockResolvedValue({
    bytes: [1, 2, 3],
    mime_type: 'image/png'
  });
});

describe('Markdown note exporters', () => {
  it.each(markdownExporters)(
    'saves $label with its format and filename',
    async (exporter) => {
      await exporter.run(note.id);
      expect(loadNote).toHaveBeenCalledWith(note.id);
      expect(saveFileExport).toHaveBeenCalledOnce();
      const saved = saveFileExport.mock.calls[0][0];
      const format = exporter.id.split('.')[1];
      expect(saved.suggestedName).toBe(`Report draft.${format}`);
      expect(saved.extensions).toEqual([format]);
      if (format === 'md') {
        expect(saved.mime).toBe('text/markdown');
        const text = strFromU8(saved.bytes);
        expect(text).toContain('title: "Report: draft"');
        expect(text).toContain('favourite: true');
        expect(text).toContain('  - research');
        expect(text).toContain(note.body);
      } else if (format === 'html') {
        expect(saved.mime).toBe('text/html');
        expect(strFromU8(saved.bytes)).toContain('<strong>useful</strong>');
      } else if (format === 'pdf') {
        expect(saved.mime).toBe('application/pdf');
        const pdf = await PDFDocument.load(saved.bytes);
        expect(pdf.getTitle()).toBe(note.title);
        expect(pdf.getPageCount()).toBe(1);
      } else {
        expect(saved.mime).toContain('wordprocessingml.document');
        const archive = unzipSync(saved.bytes);
        expect(strFromU8(archive['word/document.xml'])).toContain('useful');
        expect(strFromU8(archive['docProps/core.xml'])).toContain(note.title);
      }
    }
  );

  it.each(markdownExporters)(
    'rejects other note kinds for $label',
    async (exporter) => {
      loadNote.mockResolvedValue({ ...note, note_kind: 'kanban' });
      await expect(exporter.run(note.id)).rejects.toThrow(
        'only available for Markdown notes'
      );
      expect(saveFileExport).not.toHaveBeenCalled();
    }
  );

  it.each(['md', 'html'])(
    'embeds stored images in the saved %s file',
    async (format) => {
      loadNote.mockResolvedValue({
        ...note,
        body: '![Chart](asset:mindstream/chart)'
      });
      await markdownExporters
        .find((entry) => entry.id === `markdown.${format}`)!
        .run(note.id);
      expect(fetchDrawingAsset).toHaveBeenCalledWith('chart');
      expect(strFromU8(saveFileExport.mock.calls[0][0].bytes)).toContain(
        'data:image/png;base64,AQID'
      );
    }
  );

  it('does not save a partial file when a stored image is missing', async () => {
    loadNote.mockResolvedValue({
      ...note,
      body: '![Chart](asset:mindstream/missing)'
    });
    fetchDrawingAsset.mockRejectedValue(new Error('Asset not found'));
    await expect(markdownExporters[0].run(note.id)).rejects.toThrow(
      'Asset not found'
    );
    expect(saveFileExport).not.toHaveBeenCalled();
  });
});
