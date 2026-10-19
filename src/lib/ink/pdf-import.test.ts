import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  convertPdfToInk,
  preparePdfHandwriting,
  upgradePdfBackgrounds
} from './pdf-import';
import { InkDocument } from './document';
import type { InkPage } from './page';
import type { PdfAnnotation } from '$lib/pdf/types';

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  importNote: vi.fn(),
  load: vi.fn(),
  tree: vi.fn(),
  sync: vi.fn(),
  build: vi.fn(),
  index: vi.fn(),
  open: vi.fn(),
  images: vi.fn(),
  image: vi.fn()
}));
vi.mock('$lib/api/assets', () => ({
  fetchAssetBytes: h.fetch,
  importInkPdfNote: h.importNote
}));
vi.mock('$lib/api/notes', () => ({ loadNote: h.load }));
vi.mock('$lib/stores/tree.svelte', () => ({ loadTree: h.tree }));
vi.mock('$lib/sync/runner', () => ({ runSync: h.sync }));
vi.mock('$lib/note-exporters/pdf', () => ({ buildPdfNoteBytes: h.build }));
vi.mock('./pdf-backgrounds', () => ({
  openPdf: h.open,
  indexInkNote: h.index
}));
vi.mock('./page-images', () => ({
  savePdfPageImages: h.images,
  savePageImage: h.image
}));

const pages: InkPage[] = [
  {
    id: 'portrait',
    width: 1190,
    height: 1684,
    background: { kind: 'image', assetId: 'image-1', pageIndex: 0 }
  },
  {
    id: 'landscape',
    width: 1684,
    height: 1190,
    background: { kind: 'image', assetId: 'image-2', pageIndex: 1 }
  }
];
const documents: InkDocument[] = [];
function state() {
  const ink = new InkDocument();
  documents.push(ink);
  return ink;
}
function note(ink = state()) {
  return {
    id: 'original',
    title: 'Paper',
    parent_collection_id: 'collection',
    note_kind: 'pdf',
    body: JSON.stringify({ pdfAssetId: 'source' }),
    yrs_state: Array.from(ink.encode())
  };
}
function annotate(
  ink: InkDocument,
  id: string,
  type = 'highlight',
  deletedAt?: string
) {
  ink.doc.getMap('pdf_annotations').set(id, { id, type, deletedAt });
}
let pdf: {
  numPages: number;
  destroy: ReturnType<typeof vi.fn>;
  getPage: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  vi.resetAllMocks();
  pdf = {
    numPages: 2,
    destroy: vi.fn(async () => {}),
    getPage: vi.fn(async () => ({}))
  };
  h.open.mockResolvedValue(pdf);
  h.load.mockResolvedValue(note());
  h.fetch.mockResolvedValue(new Uint8Array([1]));
  h.build.mockResolvedValue(new Uint8Array([9]));
  h.images.mockResolvedValue(structuredClone(pages));
  h.importNote.mockResolvedValue({ id: 'converted' });
  h.sync.mockResolvedValue(undefined);
  h.index.mockResolvedValue(undefined);
});
afterEach(() => {
  documents.splice(0).forEach((ink) => ink.doc.destroy());
  vi.restoreAllMocks();
});

describe('convert PDF to an independent ink note', () => {
  it('keeps source metadata, imports saved page images, and indexes the new note', async () => {
    const progress = vi.fn();
    expect(await convertPdfToInk('original', progress)).toBe('converted');
    expect(h.fetch).toHaveBeenCalledWith('source', 'application/pdf');
    expect(h.build).not.toHaveBeenCalled();
    expect(h.images).toHaveBeenCalledWith(pdf, [0, 1], 'original', progress);
    const input = h.importNote.mock.calls[0][0];
    expect(input).toMatchObject({
      title: 'Paper',
      parent_collection_id: 'collection',
      bytes: [],
      asset_id: 'image-1'
    });
    const reopened = InkDocument.fromBytes(input.yrs_state);
    documents.push(reopened);
    expect(reopened.pages()).toEqual(pages);
    expect(h.tree).toHaveBeenCalledOnce();
    expect(h.index).toHaveBeenCalledWith('converted');
    expect(h.sync).toHaveBeenCalledOnce();
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });
  it.each(['annotation', 'form', 'shared ink'])(
    'flattens %s before rasterization',
    async (kind) => {
      const ink = state();
      if (kind === 'annotation') annotate(ink, 'mark');
      if (kind === 'form')
        ink.doc.getMap('pdf_form_values').set('field', 'value');
      if (kind === 'shared ink')
        ink.addStrokes([
          {
            color: 0xff000000,
            width: 2,
            points: [{ x: 50, y: 50, pressure: 1 }]
          }
        ]);
      h.load.mockResolvedValue(note(ink));
      await convertPdfToInk('original');
      expect(h.build).toHaveBeenCalledWith('original');
      expect(h.open).toHaveBeenCalledWith(new Uint8Array([9]));
      expect(h.fetch).not.toHaveBeenCalled();
    }
  );
  it('ignores deleted annotations when deciding whether to flatten', async () => {
    const ink = state();
    annotate(ink, 'deleted', 'highlight', 'yesterday');
    h.load.mockResolvedValue(note(ink));
    await convertPdfToInk('original');
    expect(h.build).not.toHaveBeenCalled();
  });
  it.each([
    [{ note_kind: 'markdown' }, 'Choose a PDF note'],
    [{ note_kind: 'pdf', body: '{}' }, 'PDF source is missing']
  ])(
    'rejects invalid sources before opening the PDF',
    async (source, message) => {
      h.load.mockResolvedValue(source);
      await expect(convertPdfToInk('original')).rejects.toThrow(message);
      expect(h.open).not.toHaveBeenCalled();
      expect(h.importNote).not.toHaveBeenCalled();
    }
  );
  it.each(['render', 'persist'])(
    'destroys the PDF and avoids success side effects after a %s failure',
    async (failure) => {
      if (failure === 'render')
        h.images.mockRejectedValue(new Error('render failed'));
      else h.importNote.mockRejectedValue(new Error('persist failed'));
      await expect(convertPdfToInk('original')).rejects.toThrow('failed');
      expect(pdf.destroy).toHaveBeenCalledOnce();
      expect(h.tree).not.toHaveBeenCalled();
      expect(h.sync).not.toHaveBeenCalled();
    }
  );
  it('returns the new note even when background indexing or sync fails', async () => {
    h.index.mockRejectedValue(new Error('index offline'));
    h.sync.mockRejectedValue(new Error('sync offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(convertPdfToInk('original')).resolves.toBe('converted');
    expect(warn).toHaveBeenCalledWith(
      '[ink] indexing failed',
      expect.any(Error)
    );
    expect(warn).toHaveBeenCalledWith('[ink] sync failed', expect.any(Error));
  });
});

describe('prepare shared PDF handwriting', () => {
  it('uses stable page IDs and a sorted signature of annotations and form values', async () => {
    const ink = state();
    annotate(ink, 'z');
    annotate(ink, 'a');
    annotate(ink, 'old', 'comment', 'yesterday');
    annotate(ink, 'pen', 'ink');
    ink.doc.getMap('pdf_form_values').set('z', 'last');
    ink.doc.getMap('pdf_form_values').set('a', 'first');
    h.load.mockResolvedValue(note(ink));
    const result = await preparePdfHandwriting('original');
    const annotations = [
      ...ink.doc.getMap<PdfAnnotation>('pdf_annotations').values()
    ]
      .filter((a) => a.id === 'a' || a.id === 'z')
      .sort((a, b) => a.id.localeCompare(b.id));
    const signature = JSON.stringify([
      'source',
      annotations,
      [
        ['a', 'first'],
        ['z', 'last']
      ]
    ]);
    expect(result.map((p) => p.id)).toEqual(['pdf-page-0', 'pdf-page-1']);
    expect(
      result.every((p) => p.background!.sourceSignature === signature)
    ).toBe(true);
    expect(h.build).toHaveBeenCalledWith('original', false, false);
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });
  it('does not flatten legacy ink or already shared strokes into the backgrounds', async () => {
    const ink = state();
    annotate(ink, 'legacy', 'ink');
    ink.addStrokes([
      { color: 0xff000000, width: 2, points: [{ x: 50, y: 50, pressure: 1 }] }
    ]);
    h.load.mockResolvedValue(note(ink));
    const progress = vi.fn();
    await preparePdfHandwriting('original', progress);
    expect(h.build).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledWith('source', 'application/pdf');
    expect(h.images).toHaveBeenCalledWith(pdf, [0, 1], 'original', progress);
  });
  it('rebuilds persisted backgrounds when annotation signatures change', async () => {
    const ink = state();
    ink.restorePages(
      pages.map((p) => ({
        ...p,
        background: { ...p.background!, sourceSignature: 'obsolete' }
      }))
    );
    h.load.mockResolvedValue(note(ink));
    await preparePdfHandwriting('original');
    expect(h.images).toHaveBeenCalledOnce();
  });
  it('rejects missing sources and destroys failed rasterization workers', async () => {
    h.load.mockResolvedValueOnce({ body: '{}' });
    await expect(preparePdfHandwriting('original')).rejects.toThrow(
      'PDF source is missing'
    );
    h.images.mockRejectedValueOnce(new Error('render failed'));
    await expect(preparePdfHandwriting('original')).rejects.toThrow(
      'render failed'
    );
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });
});

describe('legacy flattened PDF upgrades', () => {
  it('reuses a separate original text source and closes both documents', async () => {
    const ink = state();
    ink.restorePages(
      pages.map((p, i) => ({
        ...p,
        background: {
          assetId: 'flattened',
          textAssetId: 'original-text',
          pageIndex: i
        }
      }))
    );
    const cleanup = vi.fn();
    const text = {
      destroy: vi.fn(async () => {}),
      getPage: vi.fn(async () => ({
        getTextContent: async () => ({
          items: [{ str: 'original words' }, {}]
        }),
        cleanup
      }))
    };
    h.open.mockResolvedValueOnce(pdf).mockResolvedValueOnce(text);
    h.image.mockImplementation(async (_page, index) =>
      structuredClone(pages[index])
    );
    const apply = vi.fn(async () => {}),
      progress = vi.fn();
    await upgradePdfBackgrounds('ink', ink, apply, progress);
    expect(h.fetch.mock.calls).toEqual([
      ['flattened', 'application/pdf'],
      ['original-text', 'application/pdf']
    ]);
    expect(ink.pages().map((p) => p.background!.text)).toEqual([
      'original words ',
      'original words '
    ]);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(text.destroy).toHaveBeenCalledOnce();
    expect(pdf.destroy).toHaveBeenCalledOnce();
    expect(progress.mock.calls).toEqual([
      [1, 2],
      [2, 2]
    ]);
    expect(apply).toHaveBeenCalledTimes(2);
  });
  it('closes rendering and text documents if persistence fails', async () => {
    const ink = state();
    ink.restorePages([
      {
        ...pages[0],
        background: { assetId: 'flat', textAssetId: 'text', pageIndex: 0 }
      }
    ]);
    const text = {
      destroy: vi.fn(async () => {}),
      getPage: async () => ({
        getTextContent: async () => ({ items: [] }),
        cleanup: vi.fn()
      })
    };
    h.open.mockResolvedValueOnce(pdf).mockResolvedValueOnce(text);
    h.image.mockResolvedValue(structuredClone(pages[0]));
    await expect(
      upgradePdfBackgrounds('ink', ink, async () => {
        throw new Error('write failed');
      })
    ).rejects.toThrow('write failed');
    expect(pdf.destroy).toHaveBeenCalledOnce();
    expect(text.destroy).toHaveBeenCalledOnce();
  });
});
