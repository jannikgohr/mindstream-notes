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

const pdfNote = (id: string, assetId: string) => ({
  id,
  body: JSON.stringify({ pdfAssetId: assetId }),
  note_kind: 'pdf'
});

async function importBackfill() {
  return import('./search-index-backfill');
}

beforeEach(() => {
  vi.resetModules();
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
    const { startPdfSearchIndexing } = await importBackfill();
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
    const { startPdfSearchIndexing } = await importBackfill();
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

  it('logs listener registration failures and retries on the next start', async () => {
    const { startPdfSearchIndexing } = await importBackfill();
    const error = new Error('event bus unavailable');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    listenMock.mockRejectedValueOnce(error);

    startPdfSearchIndexing();

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        '[pdf-index] sync listener registration failed',
        error
      );
    });

    startPdfSearchIndexing();

    expect(listenMock).toHaveBeenCalledTimes(2);
  });
});
