import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { readSceneFromYDoc } from '$lib/freeform/excalidraw-yjs';
import { buildExcalidrawFile } from './excalidraw';

const { fetchDrawingAsset } = vi.hoisted(() => ({
  fetchDrawingAsset: vi.fn()
}));
vi.mock('$lib/api/assets', () => ({
  fetchDrawingAsset,
  uploadDrawingAsset: vi.fn()
}));
// Keep the actual scene reader and Yjs encoding. The editor runtime is unused.
vi.mock('@excalidraw/excalidraw', () => ({
  CaptureUpdateAction: { NEVER: 'NEVER' }
}));

const docs: Y.Doc[] = [];
function document() {
  const doc = new Y.Doc();
  docs.push(doc);
  return doc;
}

beforeEach(() => {
  fetchDrawingAsset
    .mockReset()
    .mockResolvedValue({ bytes: [1, 2, 3], mime_type: 'image/png' });
});
afterEach(() => {
  vi.restoreAllMocks();
  docs.splice(0).forEach((doc) => doc.destroy());
});

describe('drawing export scene integration', () => {
  it('reads an empty scene without inventing elements or files', () => {
    expect(readSceneFromYDoc(document())).toEqual({
      elements: [],
      appState: {},
      storedFiles: {}
    });
  });

  it('exports the stored scene order, retaining new elements and inlining image assets', async () => {
    const doc = document();
    const first = { id: 'first', type: 'rectangle', x: 10 };
    const second = { id: 'second', type: 'image', fileId: 'image-1', x: 20 };
    const added = { id: 'added', type: 'text', text: 'Fresh text', x: 30 };
    doc.getMap('excalidraw:elements').set('first', first);
    doc.getMap('excalidraw:elements').set('second', second);
    doc.getMap('excalidraw:elements').set('added', added);
    doc
      .getMap('excalidraw:scene')
      .set('elementOrder', ['second', 'removed', 'first']);
    doc
      .getMap('excalidraw:scene')
      .set('appState', { name: 'Diagram', viewBackgroundColor: '#ffffff' });
    doc.getMap('excalidraw:files').set('image-1', {
      assetId: 'asset-1',
      mimeType: 'image/png',
      created: 1
    });

    const file = await buildExcalidrawFile(Y.encodeStateAsUpdate(doc));
    expect(file).toMatchObject({
      type: 'excalidraw',
      version: 2,
      elements: [second, first, added],
      appState: { name: 'Diagram', viewBackgroundColor: '#ffffff' }
    });
    expect(file!.files['image-1']).toMatchObject({
      dataURL: 'data:image/png;base64,AQID',
      mimeType: 'image/png'
    });
    expect(fetchDrawingAsset).toHaveBeenCalledWith('asset-1');
  });

  it('returns independent scene objects so export mutations cannot alter the live document', () => {
    const doc = document();
    doc.getMap('excalidraw:elements').set('shape', { id: 'shape', x: 10 });
    doc.getMap('excalidraw:scene').set('appState', { name: 'Original' });
    doc
      .getMap('excalidraw:files')
      .set('image', { assetId: 'original', mimeType: 'image/png', created: 1 });
    const snapshot = readSceneFromYDoc(doc);
    Object.assign(snapshot.elements[0], { x: 999 });
    Object.assign(snapshot.appState, { name: 'Changed' });
    Object.assign(snapshot.storedFiles.image, { assetId: 'changed' });
    expect(readSceneFromYDoc(doc)).toEqual({
      elements: [{ id: 'shape', x: 10 }],
      appState: { name: 'Original' },
      storedFiles: {
        image: { assetId: 'original', mimeType: 'image/png', created: 1 }
      }
    });
  });

  it('migrates legacy snapshots and keeps their inline image bytes', async () => {
    const doc = document();
    const meta = doc.getMap('excalidraw:scene');
    const element = { id: 'legacy-image', type: 'image', fileId: 'image-1' };
    const file = {
      id: 'image-1',
      dataURL: 'data:image/png;base64,AQID',
      mimeType: 'image/png',
      created: 1
    };
    meta.set('elements', [element]);
    meta.set('files', { 'image-1': file });
    meta.set('appState', { viewBackgroundColor: '#ffffff' });
    const snapshot = readSceneFromYDoc(doc);
    expect(snapshot.elements).toEqual([element]);
    expect(meta.get('version')).toBe(2);
    expect(meta.has('elements')).toBe(false);
    expect(meta.has('files')).toBe(false);
    expect(
      (await buildExcalidrawFile(Y.encodeStateAsUpdate(doc)))!.files
    ).toEqual({ 'image-1': file });
    expect(fetchDrawingAsset).not.toHaveBeenCalled();
  });

  it('rejects missing assets and releases the decoded export document', async () => {
    const doc = document();
    doc
      .getMap('excalidraw:files')
      .set('image', { assetId: 'missing', mimeType: 'image/png', created: 1 });
    const bytes = Y.encodeStateAsUpdate(doc);
    const destroy = vi.spyOn(Y.Doc.prototype, 'destroy');
    fetchDrawingAsset.mockRejectedValue(new Error('Missing image asset'));
    await expect(buildExcalidrawFile(bytes)).rejects.toThrow(
      'Missing image asset'
    );
    expect(destroy).toHaveBeenCalledOnce();
  });
});
