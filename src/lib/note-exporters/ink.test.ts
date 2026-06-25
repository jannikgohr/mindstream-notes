import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  it('registers a single ink→PDF exporter', () => {
    expect(inkExporters).toHaveLength(1);
    expect(inkExporters[0]).toMatchObject({
      id: 'ink.pdf',
      noteKind: 'ink',
      label: 'PDF'
    });
    expect(inkExporters[0].run).toBe(exportInkNotePdf);
  });
});
