import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// The scene reader lives in the heavy Excalidraw+Yjs adapter (excluded from
// coverage and React-dependent); stub it so we test buildExcalidrawFile's
// own bytes/decode/wrapping logic in isolation.
vi.mock('$lib/freeform/excalidraw-yjs', () => ({
  readSceneFromYDoc: () => ({
    elements: [{ id: 'rect-1' }],
    appState: { viewBackgroundColor: '#fff' },
    storedFiles: {
      'file-1': { assetId: 'asset_1', mimeType: 'image/png', created: 1 }
    }
  })
}));

// Image bytes live in the assets table; the export has to inline them or the
// .excalidraw file opens elsewhere with broken images.
vi.mock('$lib/api/assets', () => ({
  fetchDrawingAsset: vi.fn(async (id: string) => ({
    id,
    owning_note_id: 'note-1',
    mime_type: 'image/png',
    size: 3,
    created: '',
    modified: '',
    pushed: false,
    bytes: [1, 2, 3]
  })),
  uploadDrawingAsset: vi.fn()
}));

import { buildExcalidrawFile } from './excalidraw';

const encodedDoc = (): Uint8Array => {
  const doc = new Y.Doc();
  doc.getMap('x').set('a', 1);
  return Y.encodeStateAsUpdate(doc);
};

describe('buildExcalidrawFile', () => {
  it('returns null for an empty byte array', async () => {
    expect(await buildExcalidrawFile([])).toBeNull();
    expect(await buildExcalidrawFile(new Uint8Array())).toBeNull();
  });

  it('wraps a decoded scene in the standard excalidraw envelope', async () => {
    const file = await buildExcalidrawFile(encodedDoc());
    expect(file).not.toBeNull();
    expect(file).toMatchObject({
      type: 'excalidraw',
      version: 2,
      source: 'https://excalidraw.com',
      elements: [{ id: 'rect-1' }],
      appState: { viewBackgroundColor: '#fff' }
    });
  });

  it('inlines asset bytes for referenced images', async () => {
    const file = await buildExcalidrawFile(encodedDoc());

    // A bare reference would export as an image the receiving app can't load.
    expect(file?.files['file-1']).toMatchObject({
      id: 'file-1',
      mimeType: 'image/png',
      dataURL: `data:image/png;base64,${btoa('')}`
    });
  });

  it('accepts a plain number[] as well as a Uint8Array', async () => {
    const file = await buildExcalidrawFile(Array.from(encodedDoc()));
    expect(file?.type).toBe('excalidraw');
  });

  it('returns null when the bytes are not a valid yjs update', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await buildExcalidrawFile([1, 2, 3, 4, 5])).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
