import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { savePageImage, savePdfPageImages } from './page-images';

const { upload } = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock('$lib/api/assets', () => ({ uploadDrawingAssetBytes: upload }));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function source(width = 595, height = 842) {
  return {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: width * scale,
      height: height * scale,
      transform: [scale, 0, 0, -scale, 0, height * scale]
    })),
    render: vi.fn((_options: { canvas: HTMLCanvasElement }) => ({
      promise: Promise.resolve(),
      cancel: vi.fn()
    })),
    getTextContent: vi.fn(async () => ({
      items: [
        { str: 'Searchable' },
        { type: 'beginMarkedContent' },
        { str: 'kiwi' }
      ]
    })),
    cleanup: vi.fn()
  };
}

const asPage = (page: ReturnType<typeof source>) =>
  page as unknown as PDFPageProxy;
let encoded: { width: number; height: number; type: string; quality: number }[];

beforeEach(() => {
  upload
    .mockReset()
    .mockResolvedValueOnce({ id: 'full' })
    .mockResolvedValueOnce({ id: 'preview' })
    .mockResolvedValue({ id: 'next' });
  encoded = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn()
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback,
    type,
    quality
  ) {
    encoded.push({
      width: this.width,
      height: this.height,
      type: type!,
      quality: quality as number
    });
    callback(new Blob([new Uint8Array([255, 216, 255])], { type }));
  });
});
afterEach(() => vi.restoreAllMocks());

describe('PDF page rasterization', () => {
  it('saves compressed page and preview assets with original geometry and searchable text', async () => {
    const page = source(842, 595);
    const result = await savePageImage(asPage(page), 7, 'note');
    expect(result).toMatchObject({
      width: 1684,
      height: 1190,
      pdfTransform: [2, 0, 0, -2, 0, 1190],
      background: {
        kind: 'image',
        assetId: 'full',
        thumbnailAssetId: 'preview',
        pageIndex: 7,
        pixelWidth: 2526,
        pixelHeight: 1785,
        text: 'Searchable  kiwi'
      }
    });
    expect(encoded).toEqual([
      { width: 2526, height: 1785, type: 'image/jpeg', quality: 0.9 },
      { width: 256, height: 181, type: 'image/jpeg', quality: 0.8 }
    ]);
    expect(upload.mock.calls.map(([input]) => input)).toEqual([
      {
        owning_note_id: 'note',
        mime_type: 'image/jpeg',
        bytes: new Uint8Array([255, 216, 255])
      },
      {
        owning_note_id: 'note',
        mime_type: 'image/jpeg',
        bytes: new Uint8Array([255, 216, 255])
      }
    ]);
    const canvas = page.render.mock.calls[0][0].canvas;
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(page.cleanup).toHaveBeenCalledOnce();
  });

  it('never enlarges tiny pages just to make a thumbnail', async () => {
    await savePageImage(asPage(source(20, 10)), 0, 'note');
    expect(encoded.map(({ width, height }) => [width, height])).toEqual([
      [60, 30],
      [60, 30]
    ]);
  });

  it('rejects an already cancelled operation before rendering or uploading', async () => {
    const signal = AbortSignal.abort();
    const page = source();
    await expect(
      savePageImage(asPage(page), 0, 'note', signal)
    ).rejects.toThrow();
    expect(page.render).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('cancels a pending renderer and releases its canvas and decoded images', async () => {
    const controller = new AbortController();
    const rendered = deferred();
    const page = source();
    const cancel = vi.fn(() => rendered.reject(new Error('render cancelled')));
    page.render.mockReturnValue({ promise: rendered.promise, cancel });
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const saving = savePageImage(asPage(page), 0, 'note', controller.signal);
    const rejected = expect(saving).rejects.toThrow('render cancelled');
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
    expect(page.cleanup).toHaveBeenCalledOnce();
    expect(page.render.mock.calls[0][0].canvas.width).toBe(0);
    expect(upload).not.toHaveBeenCalled();
  });

  it.each(['compression', 'text', 'upload'])(
    'cleans up after a %s failure',
    async (failure) => {
      const page = source();
      if (failure === 'compression')
        vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementationOnce(
          (done) => done(null)
        );
      if (failure === 'text')
        page.getTextContent.mockRejectedValueOnce(new Error('text failed'));
      if (failure === 'upload')
        upload.mockReset().mockRejectedValue(new Error('upload failed'));
      await expect(savePageImage(asPage(page), 0, 'note')).rejects.toThrow();
      expect(page.cleanup).toHaveBeenCalledOnce();
      expect(page.render.mock.calls[0][0].canvas.width).toBe(0);
      if (failure !== 'upload') expect(upload).not.toHaveBeenCalled();
    }
  );

  it('reports unavailable canvas contexts before starting PDF work', async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null);
    const page = source();
    await expect(savePageImage(asPage(page), 0, 'note')).rejects.toThrow(
      'PDF canvas is unavailable'
    );
    expect(page.render).not.toHaveBeenCalled();
  });

  it('does not upload orphaned images if the import closes during text extraction', async () => {
    const controller = new AbortController();
    const page = source();
    page.getTextContent.mockImplementationOnce(async () => {
      controller.abort();
      return { items: [] };
    });
    await expect(
      savePageImage(asPage(page), 0, 'note', controller.signal)
    ).rejects.toThrow();
    expect(upload).not.toHaveBeenCalled();
    expect(page.cleanup).toHaveBeenCalledOnce();
  });

  it('renders only selected pages in selection order and reports progress', async () => {
    const page = source();
    const getPage = vi.fn(async (_number: number) => asPage(page));
    const progress = vi.fn();
    const results = await savePdfPageImages(
      { getPage } as unknown as PDFDocumentProxy,
      [3, 0],
      'note',
      progress
    );
    expect(getPage.mock.calls).toEqual([[4], [1]]);
    expect(results.map((p) => p.background!.pageIndex)).toEqual([3, 0]);
    expect(progress.mock.calls).toEqual([
      [0, 2],
      [1, 2],
      [2, 2]
    ]);
    expect(page.cleanup).toHaveBeenCalledTimes(2);
  });

  it('stops before fetching the next page when cancelled between pages', async () => {
    const controller = new AbortController();
    const getPage = vi.fn(async () => asPage(source()));
    await expect(
      savePdfPageImages(
        { getPage } as unknown as PDFDocumentProxy,
        [0, 1],
        'note',
        (done) => {
          if (done === 1) controller.abort();
        },
        controller.signal
      )
    ).rejects.toThrow();
    expect(getPage).toHaveBeenCalledTimes(1);
  });
});
