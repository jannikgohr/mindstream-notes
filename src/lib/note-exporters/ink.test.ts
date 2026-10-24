import { beforeEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';

const { pdfPngFiles, saveFileExport } = vi.hoisted(() => ({
  pdfPngFiles: vi.fn(),
  saveFileExport: vi.fn()
}));
vi.mock('./pdf-images', () => ({ pdfPngFiles }));
vi.mock('$lib/api/file-export', () => ({ saveFileExport }));

const { loadNote, saveAnnotatedPdf, buildInkPdf, sanitizePdfFilename } =
  vi.hoisted(() => ({
    loadNote: vi.fn(),
    saveAnnotatedPdf: vi.fn(),
    buildInkPdf: vi.fn(),
    sanitizePdfFilename: vi.fn((s: string) => s)
  }));

vi.mock('$lib/api', () => ({ loadNote }));
vi.mock('$lib/api/pdf-export', () => ({ saveAnnotatedPdf }));
vi.mock('$lib/notes-export/ink-pdf', () => ({ buildInkPdf }));
vi.mock('$lib/pdf/filename', () => ({ sanitizePdfFilename }));

import { exportInkNotePdf, inkExporters } from './ink';

const inkNote = (over: Record<string, unknown> = {}) => ({
  id: 'n1',
  title: 'My Notes',
  note_kind: 'ink',
  yrs_state: [1, 2, 3],
  ...over
});

beforeEach(() => {
  loadNote.mockReset();
  saveAnnotatedPdf.mockReset().mockResolvedValue(undefined);
  buildInkPdf.mockReset();
  sanitizePdfFilename.mockReset().mockImplementation((s: string) => s);
  pdfPngFiles.mockReset();
  saveFileExport.mockReset().mockResolvedValue(true);
});

describe('exportInkNotePdf', () => {
  it('rejects a note that is not an ink note', async () => {
    loadNote.mockResolvedValue(inkNote({ note_kind: 'markdown' }));
    await expect(exportInkNotePdf('n1')).rejects.toThrow(/handwritten/i);
    expect(buildInkPdf).not.toHaveBeenCalled();
  });

  it('rejects when the ink state cannot be decoded', async () => {
    loadNote.mockResolvedValue(inkNote());
    buildInkPdf.mockResolvedValue(null);
    await expect(exportInkNotePdf('n1')).rejects.toThrow(/unreadable/i);
    expect(saveAnnotatedPdf).not.toHaveBeenCalled();
  });

  it('builds the PDF and saves it under a sanitised filename', async () => {
    loadNote.mockResolvedValue(inkNote({ title: 'A/B:C' }));
    sanitizePdfFilename.mockReturnValue('A-B-C');
    const bytes = new Uint8Array([37, 80, 68, 70]);
    buildInkPdf.mockResolvedValue(bytes);

    await exportInkNotePdf('n1');

    expect(buildInkPdf).toHaveBeenCalledWith([1, 2, 3]);
    expect(saveAnnotatedPdf).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'A-B-C.pdf', bytes })
    );
  });
});

describe('inkExporters', () => {
  it('registers PDF and PNG exporters', () => {
    expect(inkExporters).toHaveLength(2);
    expect(inkExporters[0]).toMatchObject({
      id: 'ink.pdf',
      noteKind: 'ink',
      label: 'PDF'
    });
    expect(inkExporters[0].run).toBe(exportInkNotePdf);
  });

  const pngExporter = inkExporters[1];

  it.each([1, 2])(
    'saves %s PNG pages without losing any page bytes',
    async (count) => {
      loadNote.mockResolvedValue(inkNote());
      const pdfBytes = new Uint8Array([37, 80, 68, 70]);
      buildInkPdf.mockResolvedValue(pdfBytes);
      const pages = Array.from({ length: count }, (_, index) => ({
        name: `My Notes - 00${index + 1}.png`,
        format: 'png',
        bytes: new TextEncoder().encode(`page ${index + 1}`)
      }));
      pdfPngFiles.mockResolvedValue(pages);
      await pngExporter.run('n1');
      expect(pdfPngFiles).toHaveBeenCalledWith(pdfBytes, 'My Notes');
      const saved = saveFileExport.mock.calls[0][0];
      if (count === 1) {
        expect(saved).toMatchObject({
          suggestedName: 'My Notes.png',
          bytes: pages[0].bytes,
          mime: 'image/png'
        });
      } else {
        expect(saved).toMatchObject({
          suggestedName: 'My Notes.zip',
          mime: 'application/zip'
        });
        const archive = unzipSync(saved.bytes);
        expect(Object.keys(archive)).toEqual(pages.map((page) => page.name));
        expect(strFromU8(archive['My Notes - 002.png'])).toBe('page 2');
      }
    }
  );

  it('rejects PNG export for other note kinds', async () => {
    loadNote.mockResolvedValue(inkNote({ note_kind: 'markdown' }));
    await expect(pngExporter.run('n1')).rejects.toThrow(
      'only available for handwritten notes'
    );
    expect(buildInkPdf).not.toHaveBeenCalled();
    expect(saveFileExport).not.toHaveBeenCalled();
  });

  it('rejects unreadable ink before rendering PNG pages', async () => {
    loadNote.mockResolvedValue(inkNote());
    buildInkPdf.mockResolvedValue(null);
    await expect(pngExporter.run('n1')).rejects.toThrow('state is unreadable');
    expect(pdfPngFiles).not.toHaveBeenCalled();
    expect(saveFileExport).not.toHaveBeenCalled();
  });

  it('does not save a partial PNG export when rendering fails', async () => {
    loadNote.mockResolvedValue(inkNote());
    buildInkPdf.mockResolvedValue(new Uint8Array([1]));
    pdfPngFiles.mockRejectedValue(new Error('Page 2 failed'));
    await expect(pngExporter.run('n1')).rejects.toThrow('Page 2 failed');
    expect(saveFileExport).not.toHaveBeenCalled();
  });
});
