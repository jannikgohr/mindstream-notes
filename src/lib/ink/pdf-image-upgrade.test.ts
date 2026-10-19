import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InkDocument } from './document';
import { INK_PAGES } from './page-document';
import type { InkPage } from './page';
import { preparePdfHandwriting, upgradePdfBackgrounds } from './pdf-import';

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
  loadNote: vi.fn(),
  destroy: vi.fn()
}));
vi.mock('$lib/api/assets', async (orig) => ({
  ...(await orig<typeof import('$lib/api/assets')>()),
  fetchAssetBytes: h.fetch
}));
vi.mock('$lib/api/notes', async (orig) => ({
  ...(await orig<typeof import('$lib/api/notes')>()),
  loadNote: h.loadNote
}));
vi.mock('./pdf-backgrounds', () => ({
  openPdf: h.open,
  indexInkNote: vi.fn()
}));
vi.mock('./page-images', () => ({
  savePageImage: h.save,
  savePdfPageImages: vi.fn()
}));

beforeEach(() => {
  vi.clearAllMocks();
  h.fetch.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
  h.open.mockResolvedValue({
    numPages: 2,
    getPage: async () => ({}),
    destroy: h.destroy
  });
  h.save.mockImplementation(async (_source, index) => ({
    id: 'generated',
    width: 1684,
    height: 1190,
    background: {
      kind: 'image',
      assetId: `asset_image_${index}`,
      thumbnailAssetId: `asset_thumb_${index}`,
      pageIndex: index,
      text: `text ${index}`,
      pixelWidth: 2526,
      pixelHeight: 1785
    }
  }));
});

function legacy() {
  const ink = new InkDocument();
  ink.restorePages([
    {
      id: 'first',
      width: 1190,
      height: 1684,
      background: { assetId: 'asset_pdf', pageIndex: 0 }
    },
    {
      id: 'second',
      width: 1684,
      height: 1190,
      background: { assetId: 'asset_pdf', pageIndex: 1 }
    }
  ]);
  ink.addStrokes([
    {
      color: 0xff123456,
      width: 4,
      points: [
        { x: 400, y: 80, pressure: 0.5 },
        { x: 440, y: 100, pressure: 0.8 }
      ]
    }
  ]);
  return ink;
}

describe('saved PDF page images', () => {
  it('upgrades existing backgrounds once while preserving strokes, IDs, dimensions and order', async () => {
    const ink = legacy();
    const strokes = ink.visibleStrokes();
    const apply = vi.fn(async () => {});
    await upgradePdfBackgrounds('note_1', ink, apply);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.destroy).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(2);
    const reopened = InkDocument.fromBytes(ink.encode());
    expect(
      reopened.pages().map((p) => [p.id, p.width, p.height, p.background?.kind])
    ).toEqual([
      ['first', 1190, 1684, 'image'],
      ['second', 1684, 1190, 'image']
    ]);
    expect(reopened.visibleStrokes()).toEqual(strokes);
    vi.clearAllMocks();
    await upgradePdfBackgrounds('note_1', reopened, apply);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
    ink.doc.destroy();
    reopened.doc.destroy();
  });

  it('does not overwrite a background changed by another editor while conversion is in flight', async () => {
    const ink = legacy();
    h.save.mockImplementationOnce(async () => {
      const current = ink.pages()[0];
      ink.doc.getMap<InkPage>(INK_PAGES).set(current.id, {
        ...current,
        background: { kind: 'image', assetId: 'asset_remote', pageIndex: 0 }
      });
      return {
        background: { kind: 'image', assetId: 'asset_stale', pageIndex: 0 }
      };
    });
    await upgradePdfBackgrounds('note_1', ink, async () => {});
    expect(ink.pages()[0].background?.assetId).toBe('asset_remote');
    ink.doc.destroy();
  });

  it('cancels an upgrade before reading the source after the editor closes', async () => {
    const ink = legacy();
    const controller = new AbortController();
    controller.abort();
    await expect(
      upgradePdfBackgrounds(
        'note_1',
        ink,
        async () => {},
        undefined,
        controller.signal
      )
    ).rejects.toThrow();
    expect(h.fetch).not.toHaveBeenCalled();
    ink.doc.destroy();
  });

  it('reopens PDF handwriting using persisted dimensions and images without parsing the PDF again', async () => {
    const ink = new InkDocument();
    ink.restorePages([
      {
        id: 'pdf-page-0',
        width: 1684,
        height: 1190,
        background: {
          kind: 'image',
          assetId: 'asset_jpeg',
          pageIndex: 0,
          sourceSignature: JSON.stringify(['asset_original', [], []])
        }
      }
    ]);
    h.loadNote.mockResolvedValue({
      note_kind: 'pdf',
      body: JSON.stringify({ pdfAssetId: 'asset_original' }),
      yrs_state: Array.from(ink.encode())
    });
    const pages = await preparePdfHandwriting('pdf_1');
    expect(pages).toEqual(ink.pages());
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    ink.doc.destroy();
  });
});
