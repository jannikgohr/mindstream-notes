import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  loadNote,
  fetchAssetBytes,
  saveAnnotatedPdf,
  exportPrintReadyPdf,
  pushToast
} = vi.hoisted(() => ({
  loadNote: vi.fn(),
  fetchAssetBytes: vi.fn(),
  saveAnnotatedPdf: vi.fn(),
  exportPrintReadyPdf: vi.fn(),
  pushToast: vi.fn()
}));

vi.mock('$lib/api', () => ({ loadNote, fetchAssetBytes }));
vi.mock('$lib/api/pdf-export', () => ({ saveAnnotatedPdf }));
vi.mock('$lib/pdf/export-print-ready-pdf', () => ({ exportPrintReadyPdf }));
vi.mock('$lib/ink/pdf-annotations', () => ({
  sharedInkAnnotations: () => []
}));
vi.mock('$lib/components/toast.svelte', () => ({ pushToast }));

import {
  exportPrintReadyPdfNote,
  exportOriginalPdfNote,
  pdfExporters
} from './pdf';

const sourceBytes = new Uint8Array([37, 80, 68, 70]);
const outputBytes = new Uint8Array([1, 2, 3]);

beforeEach(() => {
  loadNote.mockReset().mockResolvedValue({
    id: 'n1',
    title: 'Lease: draft',
    note_kind: 'pdf',
    body: 'asset_lease',
    yrs_state: []
  });
  fetchAssetBytes.mockReset().mockResolvedValue(sourceBytes);
  saveAnnotatedPdf.mockReset().mockResolvedValue(true);
  exportPrintReadyPdf
    .mockReset()
    .mockResolvedValue({ bytes: outputBytes, warnings: [] });
  pushToast.mockReset();
});

describe('exportPrintReadyPdfNote', () => {
  it('rejects notes that are not PDF notes', async () => {
    loadNote.mockResolvedValue({ note_kind: 'ink', body: '', yrs_state: [] });
    await expect(exportPrintReadyPdfNote('n1')).rejects.toThrow(/PDF notes/);
    expect(exportPrintReadyPdf).not.toHaveBeenCalled();
  });

  it('builds the print-ready copy from the asset and saves it next to the annotated name', async () => {
    await exportPrintReadyPdfNote('n1');

    expect(fetchAssetBytes).toHaveBeenCalledWith(
      'asset_lease',
      'application/pdf'
    );
    expect(exportPrintReadyPdf).toHaveBeenCalledWith(
      sourceBytes,
      [],
      expect.objectContaining({ page: 'Page {page}' })
    );
    expect(saveAnnotatedPdf).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedName: 'Lease draft (print).pdf',
        bytes: outputBytes
      })
    );
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('reports each warning once the file is saved', async () => {
    exportPrintReadyPdf.mockResolvedValue({
      bytes: outputBytes,
      warnings: ['form-not-flattened', 'unsupported-characters']
    });
    await exportPrintReadyPdfNote('n1');
    expect(pushToast).toHaveBeenCalledTimes(2);
    expect(pushToast.mock.calls[0][0]).toMatch(/form/i);
    expect(pushToast.mock.calls[1][0]).toMatch(/characters/i);
  });

  it('stays quiet when the save dialog is cancelled', async () => {
    exportPrintReadyPdf.mockResolvedValue({
      bytes: outputBytes,
      warnings: ['form-not-flattened']
    });
    saveAnnotatedPdf.mockResolvedValue(false);
    await exportPrintReadyPdfNote('n1');
    expect(pushToast).not.toHaveBeenCalled();
  });
});

describe('pdfExporters', () => {
  it('lists the print-ready export after the annotated one', () => {
    expect(pdfExporters.map((exporter) => exporter.id)).toEqual([
      'pdf.annotated',
      'pdf.print-ready',
      'pdf.original',
      'pdf.markdown'
    ]);
    expect(pdfExporters[1].run).toBe(exportPrintReadyPdfNote);
  });
});

it('exports the original asset unchanged without filling forms or adding annotations', async () => {
  await exportOriginalPdfNote('n1');
  expect(saveAnnotatedPdf).toHaveBeenCalledWith(
    expect.objectContaining({
      bytes: sourceBytes,
      suggestedName: 'Lease draft (original).pdf'
    })
  );
  expect(exportPrintReadyPdf).not.toHaveBeenCalled();
});
