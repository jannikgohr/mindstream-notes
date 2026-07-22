import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pdfNotesMissingTextMock = vi.fn();
const loadNoteMock = vi.fn();
const fetchDrawingAssetMock = vi.fn();
const setPdfTextMock = vi.fn();
const extractPdfTextMock = vi.fn();
const listenMock = vi.fn();

vi.mock('$lib/api', () => ({
  pdfNotesMissingText: (...a: unknown[]) => pdfNotesMissingTextMock(...a),
  loadNote: (...a: unknown[]) => loadNoteMock(...a),
  fetchDrawingAsset: (...a: unknown[]) => fetchDrawingAssetMock(...a),
  setPdfText: (...a: unknown[]) => setPdfTextMock(...a)
}));

vi.mock('$lib/api/events', () => ({
  listen: (...a: unknown[]) => listenMock(...a),
  TauriEventName: {
    SyncCompleted: 'sync-completed'
  }
}));

vi.mock('./extract-text', () => ({
  extractPdfText: (...a: unknown[]) => extractPdfTextMock(...a)
}));

// pdfAssetIdFromBody is a pure helper; use the real one.
import { startPdfSearchIndexing } from './search-index-backfill';

const pdfNote = (id: string, assetId: string) => ({
  id,
  body: JSON.stringify({ pdfAssetId: assetId }),
  note_kind: 'pdf'
});

beforeEach(() => {
  pdfNotesMissingTextMock.mockReset().mockResolvedValue([]);
  loadNoteMock.mockReset();
  fetchDrawingAssetMock.mockReset();
  setPdfTextMock.mockReset().mockResolvedValue(undefined);
  extractPdfTextMock.mockReset().mockResolvedValue('hello pdf');
  listenMock.mockReset().mockResolvedValue(() => {});
  // Run idle callbacks synchronously-ish so the sweep completes fast.
  vi.stubGlobal('requestIdleCallback', (cb: () => void) => {
    setTimeout(cb, 0);
    return 0;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('startPdfSearchIndexing', () => {
  it('extracts and persists text for each un-indexed PDF', async () => {
    pdfNotesMissingTextMock.mockResolvedValueOnce(['n1', 'n2']);
    loadNoteMock.mockImplementation(async (id: string) =>
      pdfNote(id, `asset_${id}`)
    );
    fetchDrawingAssetMock.mockResolvedValue({
      mime_type: 'application/pdf',
      bytes: [1, 2, 3]
    });

    startPdfSearchIndexing();

    await vi.waitFor(() => {
      expect(setPdfTextMock).toHaveBeenCalledWith('n1', 'hello pdf');
      expect(setPdfTextMock).toHaveBeenCalledWith('n2', 'hello pdf');
    });
    // Arms the sync-completed listener so pulled PDFs get re-swept.
    expect(listenMock).toHaveBeenCalledWith(
      'sync-completed',
      expect.any(Function)
    );
  });

  it('skips assets that are not PDFs and survives per-note errors', async () => {
    pdfNotesMissingTextMock.mockResolvedValueOnce(['bad', 'good']);
    loadNoteMock.mockImplementation(async (id: string) =>
      pdfNote(id, `asset_${id}`)
    );
    fetchDrawingAssetMock.mockImplementation(async (assetId: string) =>
      assetId === 'asset_bad'
        ? { mime_type: 'image/png', bytes: [0] }
        : { mime_type: 'application/pdf', bytes: [1] }
    );

    startPdfSearchIndexing();

    await vi.waitFor(() => {
      expect(setPdfTextMock).toHaveBeenCalledWith('good', 'hello pdf');
    });
    expect(setPdfTextMock).not.toHaveBeenCalledWith('bad', expect.anything());
  });
});
