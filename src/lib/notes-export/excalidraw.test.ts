import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// The scene reader lives in the heavy Excalidraw+Yjs adapter (excluded from
// coverage and React-dependent); stub it so we test buildExcalidrawFile's
// own bytes/decode/wrapping logic in isolation.
vi.mock('$lib/freeform/excalidraw-yjs', () => ({
  readSceneFromYDoc: () => ({
    elements: [{ id: 'rect-1' }],
    appState: { viewBackgroundColor: '#fff' },
    files: {}
  })
}));

import { buildExcalidrawFile } from './excalidraw';

const encodedDoc = (): Uint8Array => {
  const doc = new Y.Doc();
  doc.getMap('x').set('a', 1);
  return Y.encodeStateAsUpdate(doc);
};

describe('buildExcalidrawFile', () => {
  it('returns null for an empty byte array', () => {
    expect(buildExcalidrawFile([])).toBeNull();
    expect(buildExcalidrawFile(new Uint8Array())).toBeNull();
  });

  it('wraps a decoded scene in the standard excalidraw envelope', () => {
    const file = buildExcalidrawFile(encodedDoc());
    expect(file).not.toBeNull();
    expect(file).toMatchObject({
      type: 'excalidraw',
      version: 2,
      source: 'https://excalidraw.com',
      elements: [{ id: 'rect-1' }],
      appState: { viewBackgroundColor: '#fff' },
      files: {}
    });
  });

  it('accepts a plain number[] as well as a Uint8Array', () => {
    const file = buildExcalidrawFile(Array.from(encodedDoc()));
    expect(file?.type).toBe('excalidraw');
  });

  it('returns null when the bytes are not a valid yjs update', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(buildExcalidrawFile([1, 2, 3, 4, 5])).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
