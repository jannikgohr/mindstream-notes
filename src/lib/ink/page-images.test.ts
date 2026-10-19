import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pageImageScale } from './page-images';
import {
  createPdfBackgroundCache,
  extractInkBackgroundText
} from './pdf-backgrounds';
import { InkDocument } from './document';
import type { InkPage } from './page';

const { fetchAssetBytes } = vi.hoisted(() => ({ fetchAssetBytes: vi.fn() }));
vi.mock('$lib/api/assets', () => ({
  fetchAssetBytes,
  uploadDrawingAssetBytes: vi.fn()
}));

const page: InkPage = {
  id: 'image-page',
  width: 1684,
  height: 1190,
  background: {
    kind: 'image',
    assetId: 'asset_jpeg',
    thumbnailAssetId: 'asset_preview',
    pageIndex: 3,
    pixelWidth: 2526,
    pixelHeight: 1785,
    text: 'Saved searchable mango'
  }
};

beforeEach(() => {
  fetchAssetBytes.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 800, height: 600, close: vi.fn() }))
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn()
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('persistent ink page images', () => {
  it('bounds raster size while preserving aspect ratio and standard page resolution', () => {
    expect(pageImageScale(595, 842)).toBe(3);
    for (const [width, height] of [
      [10000, 20000],
      [50000, 100],
      [1000, 1000]
    ]) {
      const scale = pageImageScale(width, height);
      expect(width * height * scale * scale).toBeLessThanOrEqual(6_000_001);
      expect(Math.max(width, height) * scale).toBeLessThanOrEqual(4096);
    }
  });

  it('persists page and pixel dimensions, image references, and extracted text across reopen', () => {
    const ink = new InkDocument();
    ink.restorePages([page]);
    const reopened = InkDocument.fromBytes(ink.encode());
    expect(reopened.pages()).toEqual([page]);
    ink.doc.destroy();
    reopened.doc.destroy();
  });

  it('loads JPEGs once and reuses them at every zoom level without fetching a PDF', async () => {
    const changed = vi.fn();
    const failed = vi.fn();
    const cache = createPdfBackgroundCache(changed, failed);
    cache.beginFrame();
    expect(cache.get(page, 1)).toBeNull();
    cache.endFrame();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    const first = cache.get(page, 1);
    expect(first).not.toBeNull();
    for (const scale of [0.5, 2, 4, 8])
      expect(cache.get(page, scale)).toBe(first);
    expect(fetchAssetBytes).toHaveBeenCalledTimes(2);
    expect(fetchAssetBytes.mock.calls.map(([id]) => id).sort()).toEqual([
      'asset_jpeg',
      'asset_preview'
    ]);
    expect(failed).not.toHaveBeenCalled();
    cache.destroy();
  });

  it('uses persisted text in page order without opening any source PDF', async () => {
    expect(
      await extractInkBackgroundText([
        page,
        {
          ...page,
          id: 'b',
          background: { ...page.background!, text: 'Next page' }
        }
      ])
    ).toBe('Saved searchable mango\n\nNext page');
    expect(fetchAssetBytes).not.toHaveBeenCalled();
  });
});
