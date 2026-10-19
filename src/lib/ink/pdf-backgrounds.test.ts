import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPdfBackgroundCache,
  extractInkBackgroundText,
  indexInkNote,
  openPdf,
  pdfPages,
  preparePdfImport
} from './pdf-backgrounds';
import { InkDocument } from './document';
import type { InkPage } from './page';

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  getDocument: vi.fn(),
  cachedText: vi.fn(),
  needsText: vi.fn(),
  setText: vi.fn(),
  loadNote: vi.fn(),
  images: vi.fn(),
  bitmap: vi.fn()
}));
vi.mock('$lib/api/assets', () => ({ fetchAssetBytes: h.fetch }));
vi.mock('$lib/api/notes', () => ({ loadNote: h.loadNote }));
vi.mock('$lib/api/pdf-text', () => ({
  cachedPdfPageText: h.cachedText,
  pdfNoteNeedsText: h.needsText,
  setPdfText: h.setText
}));
vi.mock('./page-images', () => ({ savePdfPageImages: h.images }));
vi.mock('pdfjs-dist', () => ({
  getDocument: h.getDocument,
  GlobalWorkerOptions: { workerSrc: '' }
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function documentFixture() {
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const getPage = vi.fn(async (number: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({
      width: (number === 1 ? 595 : 842) * scale,
      height: (number === 1 ? 842 : 595) * scale,
      transform: [scale, 0, 0, -scale, 0, 10]
    }),
    render,
    getTextContent: vi.fn(async () => ({
      items: [{ str: `page ${number}` }, { type: 'marked' }]
    }))
  }));
  return { numPages: 2, getPage, render };
}
let pdf: ReturnType<typeof documentFixture>;
let destroy: ReturnType<typeof vi.fn>;
const caches: ReturnType<typeof createPdfBackgroundCache>[] = [];
let serial = 0;
const legacy = (assetId = `pdf-${++serial}`, pageIndex = 0): InkPage => ({
  id: `${assetId}-${pageIndex}`,
  width: 1190,
  height: 1684,
  background: { assetId, pageIndex }
});
const image = (
  assetId = `jpg-${++serial}`,
  thumbnailAssetId?: string
): InkPage => ({
  ...legacy(assetId),
  background: { kind: 'image', assetId, pageIndex: 0, thumbnailAssetId }
});
function cache() {
  const changed = vi.fn(),
    failed = vi.fn();
  const value = createPdfBackgroundCache(changed, failed);
  caches.push(value);
  return { value, changed, failed };
}
beforeEach(() => {
  vi.resetAllMocks();
  pdf = documentFixture();
  destroy = vi.fn(async () => {});
  h.getDocument.mockImplementation(() => ({
    promise: Promise.resolve(pdf),
    destroy
  }));
  h.fetch.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
  h.cachedText.mockResolvedValue(null);
  h.bitmap.mockImplementation(async () => ({
    width: 800,
    height: 600,
    close: vi.fn()
  }));
  vi.stubGlobal('createImageBitmap', h.bitmap);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn()
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pdf-import');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  for (const value of caches.splice(0)) value.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PDF document lifetime', () => {
  it('copies input bytes before handing them to the PDF worker and owns its teardown', async () => {
    const bytes = new Uint8Array([1, 2]);
    const opened = await openPdf(bytes);
    const passed = h.getDocument.mock.calls[0][0].data;
    expect(passed).toEqual(bytes);
    expect(passed).not.toBe(bytes);
    await opened.destroy();
    expect(destroy).toHaveBeenCalledOnce();
  });
  it('reads mixed page geometry in ink units and destroys the worker', async () => {
    const pages = await pdfPages(new Uint8Array());
    expect(pages.map(({ width, height }) => [width, height])).toEqual([
      [1190, 1684],
      [1684, 1190]
    ]);
    expect(pages[0].pdfTransform).toEqual([2, 0, 0, -2, 0, 10]);
    expect(destroy).toHaveBeenCalledOnce();
  });
  it('destroys the worker when metadata lookup fails', async () => {
    pdf.getPage.mockRejectedValueOnce(new Error('bad page'));
    await expect(pdfPages(new Uint8Array())).rejects.toThrow('bad page');
    expect(destroy).toHaveBeenCalledOnce();
  });
  it('keeps a prepared import open, reads only selected pages, and closes once', async () => {
    const file = new File(['pdf'], 'source.pdf');
    const prepared = await preparePdfImport(file);
    expect(prepared.file).toBe(file);
    expect(prepared.pageCount).toBe(2);
    expect(h.getDocument).toHaveBeenCalledWith({ url: 'blob:pdf-import' });
    expect(pdf.getPage).not.toHaveBeenCalled();
    expect((await prepared.pages([1]))[0].width).toBe(1684);
    expect(pdf.getPage.mock.calls).toEqual([[2]]);
    const progress = vi.fn(),
      signal = new AbortController().signal;
    h.images.mockResolvedValue([]);
    await expect(
      prepared.images([1], 'note', progress, signal)
    ).resolves.toEqual([]);
    expect(h.images).toHaveBeenCalledWith(pdf, [1], 'note', progress, signal);
    const closing = prepared.destroy();
    expect(prepared.destroy()).toBe(closing);
    await closing;
    expect(destroy).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:pdf-import');
  });
  it('releases a failed prepared import and revokes its URL', async () => {
    h.getDocument.mockReturnValue({
      promise: Promise.reject(new Error('invalid PDF')),
      destroy
    });
    await expect(preparePdfImport(new File([], 'bad.pdf'))).rejects.toThrow(
      'invalid PDF'
    );
    expect(destroy).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });
});

describe('background cache', () => {
  it('reports preview failures while still making the full page available', async () => {
    const { value, changed, failed } = cache();
    h.fetch.mockRejectedValueOnce(new Error('preview missing'));
    const page = image('available-full', 'missing-preview');
    value.get(page, 1);
    await vi.waitFor(() => {
      expect(failed).toHaveBeenCalledOnce();
      expect(changed).toHaveBeenCalledOnce();
    });
    expect(value.get(page, 1)).not.toBeNull();
  });

  it('bounds retained thumbnails independently of the full-page cache', async () => {
    const { value, changed } = cache();
    const pages = Array.from({ length: 129 }, (_, i) =>
      image(`full-${i}`, `preview-${i}`)
    );
    for (const page of pages) value.get(page, 0.1);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(129));
    expect(value.get(pages[128], 0.1)).not.toBeNull();
    expect(value.get(pages[0], 0.1)).toBeNull();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(130));
  });

  it('evicts offscreen pages when decoded pixels exceed the budget even below eight pages', async () => {
    h.bitmap.mockImplementation(async () => ({
      width: 3000,
      height: 3000,
      close: vi.fn()
    }));
    const { value, changed } = cache();
    const pages = Array.from({ length: 3 }, () => image());
    for (const page of pages) value.get(page, 1);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(3));
    value.beginFrame();
    const retained = value.get(pages[2], 1);
    value.endFrame();
    expect(value.get(pages[2], 1)).toBe(retained);
    expect(value.get(pages[0], 1)).toBeNull();
  });
  it('uses previews at thumbnail zoom and reuses them while loading full images', async () => {
    const { value, changed } = cache();
    const page = image('full', 'thumb');
    expect(value.get(page, 0.1)).toBeNull();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    const preview = value.get(page, 0.1);
    expect(preview).not.toBeNull();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(value.get(page, 1)).toBe(preview);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    expect(value.get(page, 1)).not.toBe(preview);
    expect(value.get(page, 8)).toBe(value.get(page, 1));
  });
  it('deduplicates image requests and closes decoded bitmaps', async () => {
    const { value, changed } = cache();
    const page = image();
    for (let i = 0; i < 5; i++) value.get(page, 1);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(h.fetch).toHaveBeenCalledOnce();
    const bitmap = await h.bitmap.mock.results[0].value;
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it('reports image errors and allows the next frame to retry', async () => {
    const { value, failed, changed } = cache();
    h.fetch.mockRejectedValueOnce(new Error('offline'));
    const page = image();
    value.get(page, 1);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    value.get(page, 1);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(value.get(page, 1)).not.toBeNull();
  });
  it('ignores late image completion and errors after the editor closes', async () => {
    const { value, changed, failed } = cache();
    const waiting = deferred<Uint8Array>();
    h.fetch
      .mockReturnValueOnce(waiting.promise)
      .mockRejectedValueOnce(new Error('late preview'));
    const page = image('late', 'late-thumb');
    value.get(page, 1);
    value.destroy();
    waiting.resolve(new Uint8Array());
    await vi.waitFor(() => expect(h.bitmap).toHaveBeenCalledOnce());
    expect(value.get(page, 1)).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });
  it('evicts old full images after leaving the viewport and retains wanted pages', async () => {
    const { value, changed } = cache();
    const pages = Array.from({ length: 10 }, () => image());
    for (const page of pages) value.get(page, 1);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(10));
    value.beginFrame();
    const retained = value.get(pages[0], 1);
    value.endFrame();
    expect(value.get(pages[0], 1)).toBe(retained);
    expect(value.get(pages[1], 1)).toBeNull();
  });
  it('renders legacy pages lazily, reuses the document, and upgrades resolution', async () => {
    const { value, changed } = cache();
    const page = legacy();
    value.beginFrame();
    expect(value.get(page, 0.25)).toBeNull();
    value.endFrame();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    const low = value.get(page, 0.25);
    expect(low).not.toBeNull();
    expect(value.get(page, 1)).toBe(low);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    expect(value.get(page, 1)).not.toBe(low);
    expect(h.fetch).toHaveBeenCalledOnce();
    value.beginFrame();
    value.endFrame();
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
  });
  it('cancels offscreen PDF rendering without treating cancellation as failure', async () => {
    const { value, changed, failed } = cache();
    const waiting = deferred<void>();
    const cancel = vi.fn(() => {
      const error = new Error('cancelled');
      error.name = 'RenderingCancelledException';
      waiting.reject(error);
    });
    pdf.render.mockReturnValueOnce({ promise: waiting.promise, cancel });
    value.get(legacy(), 1);
    await vi.waitFor(() => expect(pdf.render).toHaveBeenCalledOnce());
    value.beginFrame();
    value.endFrame();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(failed).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });
  it('reports legacy rendering errors and releases failed documents for retry', async () => {
    const { value, failed, changed } = cache();
    h.fetch.mockRejectedValueOnce(new Error('missing source'));
    const page = legacy();
    value.get(page, 1);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    value.get(page, 1);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
  it('does not start obsolete PDF renders after their source finishes loading', async () => {
    const { value, changed } = cache();
    const waiting = deferred<Uint8Array>();
    h.fetch.mockReturnValueOnce(waiting.promise);
    value.get(legacy(), 1);
    value.beginFrame();
    value.endFrame();
    waiting.resolve(new Uint8Array());
    await vi.waitFor(() => expect(h.getDocument).toHaveBeenCalledOnce());
    expect(pdf.getPage).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    value.beginFrame();
    value.endFrame();
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
  });
});

describe('background search text', () => {
  it('combines persisted and extracted text in page order, fetching only missing source pages', async () => {
    const asset = `text-${++serial}`;
    const pages = [legacy(asset, 1), image(), legacy(asset, 0)];
    pages[1].background!.text = 'saved image text';
    h.cachedText.mockImplementation(
      async (_asset, index, text) =>
        text ?? (index === 0 ? 'cached first' : null)
    );
    expect(await extractInkBackgroundText(pages)).toBe(
      'page 2 \n\nsaved image text\n\ncached first'
    );
    expect(pdf.getPage.mock.calls).toEqual([[2]]);
    expect(h.cachedText).toHaveBeenCalledWith(asset, 1, 'page 2 ');
    expect(destroy).toHaveBeenCalledOnce();
    const calls = h.cachedText.mock.calls.length;
    await extractInkBackgroundText(pages);
    expect(h.cachedText).toHaveBeenCalledTimes(calls);
    expect(h.fetch).toHaveBeenCalledOnce();
  });
  it('reads the original text asset when a legacy background is flattened', async () => {
    const page = legacy();
    page.background!.textAssetId = `original-${++serial}`;
    await extractInkBackgroundText([page]);
    expect(h.fetch).toHaveBeenCalledWith(
      page.background!.textAssetId,
      'application/pdf'
    );
  });
  it('destroys the document when extraction fails', async () => {
    pdf.getPage.mockRejectedValueOnce(new Error('text error'));
    await expect(extractInkBackgroundText([legacy()])).rejects.toThrow(
      'text error'
    );
    expect(destroy).toHaveBeenCalledOnce();
  });
  it('bounds the in-memory text cache and rechecks evicted source pages', async () => {
    h.cachedText.mockResolvedValue('cached');
    const asset = `bounded-${++serial}`;
    await extractInkBackgroundText(
      Array.from({ length: 257 }, (_, i) => legacy(asset, i))
    );
    h.cachedText.mockClear();
    await extractInkBackgroundText([legacy(asset, 0)]);
    expect(h.cachedText).toHaveBeenCalledWith(asset, 0);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('indexes ink text with its current background signature', async () => {
    const ink = new InkDocument();
    const page = image();
    page.background!.text = 'indexed papaya';
    ink.restorePages([page]);
    h.needsText.mockResolvedValue(true);
    h.loadNote.mockResolvedValue({
      note_kind: 'ink',
      yrs_state: Array.from(ink.encode())
    });
    await indexInkNote('ink-note');
    expect(h.setText).toHaveBeenCalledWith(
      'ink-note',
      'indexed papaya',
      JSON.stringify([[page.id, page.background!.assetId, 0]])
    );
    ink.doc.destroy();
  });
  it('skips already indexed notes and notes whose kind changed during loading', async () => {
    h.needsText.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await indexInkNote('indexed');
    expect(h.loadNote).not.toHaveBeenCalled();
    h.loadNote.mockResolvedValue({ note_kind: 'markdown' });
    await indexInkNote('changed-kind');
    expect(h.setText).not.toHaveBeenCalled();
  });
});
