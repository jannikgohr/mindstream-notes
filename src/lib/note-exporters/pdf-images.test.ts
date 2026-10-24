import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pdfPngFiles } from './pdf-images';

const { getDocument, GlobalWorkerOptions } = vi.hoisted(() => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: '' }
}));
vi.mock('pdfjs-dist', () => ({ getDocument, GlobalWorkerOptions }));

function sourcePage(width = 595, height = 842) {
  return {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: width * scale,
      height: height * scale
    })),
    render: vi.fn((_options: { canvas: HTMLCanvasElement }) => ({
      promise: Promise.resolve()
    })),
    cleanup: vi.fn()
  };
}

let page: ReturnType<typeof sourcePage>;
const getPage = vi.fn();
const destroy = vi.fn();
let encoded: { width: number; height: number; type: string | undefined }[];

beforeEach(() => {
  page = sourcePage();
  getPage.mockReset().mockResolvedValue(page);
  destroy.mockReset().mockResolvedValue(undefined);
  getDocument.mockReset().mockImplementation(() => ({
    promise: Promise.resolve({ numPages: 1, getPage }),
    destroy
  }));
  encoded = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback,
    type
  ) {
    encoded.push({ width: this.width, height: this.height, type });
    callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type }));
  });
});

afterEach(() => vi.restoreAllMocks());

describe('PDF PNG page exports', () => {
  it('renders in page order and releases each canvas before fetching the next page', async () => {
    let finishRender!: () => void;
    page.render.mockReturnValueOnce({
      promise: new Promise<void>((resolve) => (finishRender = resolve))
    });
    const secondPage = sourcePage();
    getPage.mockImplementation(async (number: number) => {
      if (number === 2) {
        expect(page.cleanup).toHaveBeenCalledOnce();
        const canvas = page.render.mock.calls[0][0].canvas;
        expect([canvas.width, canvas.height]).toEqual([0, 0]);
      }
      return number === 1 ? page : secondPage;
    });
    getDocument.mockImplementation(() => ({
      promise: Promise.resolve({ numPages: 2, getPage }),
      destroy
    }));
    const bytes = new Uint8Array([37, 80, 68, 70]);
    const exporting = pdfPngFiles(bytes, 'Reading: notes');
    await vi.waitFor(() => expect(page.render).toHaveBeenCalledOnce());
    expect(getPage.mock.calls).toEqual([[1]]);
    finishRender();

    expect(await exporting).toEqual([
      {
        name: 'Reading notes - 001.png',
        format: 'png',
        bytes: new Uint8Array([137, 80, 78, 71])
      },
      {
        name: 'Reading notes - 002.png',
        format: 'png',
        bytes: new Uint8Array([137, 80, 78, 71])
      }
    ]);
    expect(getPage.mock.calls).toEqual([[1], [2]]);
    expect(page.render).toHaveBeenCalledWith(
      expect.objectContaining({ background: '#ffffff' })
    );
    expect(secondPage.cleanup).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(GlobalWorkerOptions.workerSrc).toContain('pdf.worker.mjs');
    const input = getDocument.mock.calls[0][0].data;
    expect(input).toEqual(bytes);
    expect(input.buffer).not.toBe(bytes.buffer);
  });

  it.each([
    [595, 842, 1190, 1684],
    [10000, 1000, 8192, 820],
    [5000, 5000, 4899, 4899],
    [0.2, 0.3, 1, 1]
  ])(
    'renders a %s by %s page within the canvas limits',
    async (width, height, expectedWidth, expectedHeight) => {
      page = sourcePage(width, height);
      getPage.mockResolvedValue(page);
      await pdfPngFiles(new Uint8Array([1]), 'Drawing');
      expect(encoded).toEqual([
        { width: expectedWidth, height: expectedHeight, type: 'image/png' }
      ]);
      const canvas = page.render.mock.calls[0][0].canvas;
      expect([canvas.width, canvas.height]).toEqual([0, 0]);
    }
  );

  it.each(['render', 'encode'])(
    'releases the page and document after a %s failure',
    async (failure) => {
      if (failure === 'render') {
        page.render.mockImplementationOnce(() => ({
          promise: Promise.reject(new Error('Rendering failed'))
        }));
      } else {
        vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementationOnce(
          (callback) => callback(null)
        );
      }
      await expect(pdfPngFiles(new Uint8Array([1]), 'Drawing')).rejects.toThrow(
        failure === 'render'
          ? 'Rendering failed'
          : 'Could not encode the PNG page.'
      );
      const canvas = page.render.mock.calls[0][0].canvas;
      expect([canvas.width, canvas.height]).toEqual([0, 0]);
      expect(page.cleanup).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledOnce();
      expect(getPage).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['document', 'page'])(
    'destroys the loading task after a %s loading failure',
    async (failure) => {
      const error = new Error('Invalid PDF');
      if (failure === 'document') {
        getDocument.mockImplementationOnce(() => ({
          promise: Promise.reject(error),
          destroy
        }));
      } else {
        getPage.mockRejectedValueOnce(error);
      }
      await expect(pdfPngFiles(new Uint8Array([1]), 'Drawing')).rejects.toBe(
        error
      );
      expect(page.render).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledOnce();
    }
  );
});
