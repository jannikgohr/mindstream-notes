import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BinaryFileData, BinaryFiles } from '@excalidraw/excalidraw/types';

const uploadDrawingAsset = vi.fn();
const fetchDrawingAsset = vi.fn();

vi.mock('$lib/api/assets', () => ({
  uploadDrawingAsset: (...args: unknown[]) => uploadDrawingAsset(...args),
  fetchDrawingAsset: (...args: unknown[]) => fetchDrawingAsset(...args)
}));

const {
  ExcalidrawFileStore,
  bytesToDataUrl,
  dataUrlToBytes,
  inlineStoredFiles,
  isLegacyInlineFile,
  isPersistedFileRef
} = await import('./excalidraw-files');

/** One-pixel-ish payload; the exact bytes just have to round-trip. */
const BYTES = [137, 80, 78, 71, 13, 10, 26, 10];
const PNG_DATA_URL = bytesToDataUrl(BYTES, 'image/png');

function file(id: string, overrides: Partial<BinaryFileData> = {}) {
  return {
    id,
    dataURL: PNG_DATA_URL,
    mimeType: 'image/png',
    created: 1,
    ...overrides
  } as BinaryFileData;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  uploadDrawingAsset.mockReset();
  fetchDrawingAsset.mockReset();
  uploadDrawingAsset.mockImplementation(async (input: { bytes: number[] }) => ({
    id: 'asset_1',
    owning_note_id: 'note-1',
    mime_type: 'image/png',
    size: input.bytes.length,
    created: '',
    modified: '',
    pushed: false,
    bytes: input.bytes
  }));
  fetchDrawingAsset.mockImplementation(async (id: string) => ({
    id,
    owning_note_id: 'note-1',
    mime_type: 'image/png',
    size: BYTES.length,
    created: '',
    modified: '',
    pushed: false,
    bytes: BYTES
  }));
});

describe('data URL conversion', () => {
  it('round-trips bytes', () => {
    const decoded = dataUrlToBytes(PNG_DATA_URL);
    expect(decoded).not.toBeNull();
    expect(decoded!.bytes).toEqual(BYTES);
    expect(decoded!.mimeType).toBe('image/png');
  });

  it('refuses anything that is not a base64 data URL', () => {
    expect(dataUrlToBytes('https://example.com/a.png')).toBeNull();
    expect(dataUrlToBytes('data:image/png,notbase64')).toBeNull();
  });

  it('handles payloads past the fromCharCode argument limit', () => {
    // The chunked encoder exists because spreading a large array into
    // String.fromCharCode throws.
    const big = Array.from({ length: 200_000 }, (_, i) => i % 256);
    const decoded = dataUrlToBytes(bytesToDataUrl(big, 'image/png'));
    expect(decoded!.bytes).toEqual(big);
  });
});

describe('stored value discrimination', () => {
  it('tells a reference from a legacy inline file', () => {
    const ref = { assetId: 'asset_1', mimeType: 'image/png', created: 1 };
    expect(isPersistedFileRef(ref)).toBe(true);
    expect(isLegacyInlineFile(ref)).toBe(false);

    const legacy = file('file-1');
    expect(isLegacyInlineFile(legacy)).toBe(true);
    // Critical: a legacy entry must never be mistaken for a reference, or
    // resolve() would look up an assetId that isn't there.
    expect(isPersistedFileRef(legacy)).toBe(false);
  });
});

describe('ExcalidrawFileStore', () => {
  it('uploads a new file once and records a reference', async () => {
    const onRefsChanged = vi.fn();
    const store = new ExcalidrawFileStore({ noteId: 'note-1', onRefsChanged });
    const files: BinaryFiles = { 'file-1': file('file-1') };

    store.ensureUploaded(files);
    store.ensureUploaded(files); // onChange fires constantly while drawing
    await flush();

    expect(uploadDrawingAsset).toHaveBeenCalledTimes(1);
    expect(uploadDrawingAsset.mock.calls[0][0]).toMatchObject({
      owning_note_id: 'note-1',
      mime_type: 'image/png',
      bytes: BYTES
    });
    expect(onRefsChanged).toHaveBeenCalled();
    expect(store.refsFor(['file-1'])['file-1']).toMatchObject({
      assetId: 'asset_1',
      mimeType: 'image/png'
    });
  });

  it('reports files as unpersisted until their upload lands', async () => {
    const store = new ExcalidrawFileStore({ noteId: 'note-1' });
    const files: BinaryFiles = { 'file-1': file('file-1') };

    store.ensureUploaded(files);
    // Mid-flight: the flush must not claim the scene is fully persisted,
    // or the reference would never be written.
    expect(store.hasAllRefs(files)).toBe(false);
    expect(store.refsFor(['file-1'])).toEqual({});

    await flush();
    expect(store.hasAllRefs(files)).toBe(true);
  });

  it('does not re-upload files adopted from the Y.Doc', async () => {
    const store = new ExcalidrawFileStore({ noteId: 'note-1' });
    store.adopt({
      'file-1': { assetId: 'asset_1', mimeType: 'image/png', created: 1 }
    });

    store.ensureUploaded({ 'file-1': file('file-1') });
    await flush();

    expect(uploadDrawingAsset).not.toHaveBeenCalled();
  });

  it('survives an upload failure without wedging the file', async () => {
    uploadDrawingAsset.mockRejectedValueOnce(new Error('disk full'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new ExcalidrawFileStore({ noteId: 'note-1' });
    const files: BinaryFiles = { 'file-1': file('file-1') };

    store.ensureUploaded(files);
    await flush();
    expect(store.hasAllRefs(files)).toBe(false);

    // The in-flight guard must have been released so a retry can happen.
    store.ensureUploaded(files);
    await flush();
    expect(store.hasAllRefs(files)).toBe(true);
    warn.mockRestore();
  });

  it('resolves references back into renderable files, fetching once', async () => {
    const store = new ExcalidrawFileStore({ noteId: 'note-1' });
    const stored = {
      'file-1': { assetId: 'asset_1', mimeType: 'image/png', created: 1 }
    };

    const first = await store.resolve(stored);
    const second = await store.resolve(stored);

    expect(first['file-1'].dataURL).toBe(PNG_DATA_URL);
    expect(second['file-1'].dataURL).toBe(PNG_DATA_URL);
    expect(fetchDrawingAsset).toHaveBeenCalledTimes(1);
  });

  it('migrates a legacy inline file into the assets table', async () => {
    const store = new ExcalidrawFileStore({ noteId: 'note-1' });

    const resolved = await store.resolve({ 'file-1': file('file-1') });
    await flush();

    // Still renders immediately from the inline bytes...
    expect(resolved['file-1'].dataURL).toBe(PNG_DATA_URL);
    // ...and is now backed by an asset, so the next write drops it from the doc.
    expect(uploadDrawingAsset).toHaveBeenCalledTimes(1);
    expect(store.refsFor(['file-1'])['file-1']?.assetId).toBe('asset_1');
  });

  it('omits an image whose asset has not synced to this device', async () => {
    fetchDrawingAsset.mockRejectedValue(new Error('not found'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new ExcalidrawFileStore({ noteId: 'note-1' });

    const resolved = await store.resolve({
      'file-1': { assetId: 'asset_missing', mimeType: 'image/png', created: 1 }
    });

    expect(resolved).toEqual({});
    warn.mockRestore();
  });
});

describe('inlineStoredFiles', () => {
  it('inlines references and passes legacy entries through', async () => {
    const resolved = await inlineStoredFiles({
      'ref-1': { assetId: 'asset_1', mimeType: 'image/png', created: 1 },
      'legacy-1': file('legacy-1')
    });

    expect(resolved['ref-1'].dataURL).toBe(PNG_DATA_URL);
    expect(resolved['legacy-1'].dataURL).toBe(PNG_DATA_URL);
  });
});
