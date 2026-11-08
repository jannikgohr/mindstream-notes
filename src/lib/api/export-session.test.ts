import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  invokeFile: vi.fn()
}));
vi.mock('./core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./core')>()),
  invokeTauri: ipc.invoke,
  invokeFile: ipc.invokeFile
}));
import { CHUNK_BYTES, ExportSession, exportAssetTypes } from './export-session';

beforeEach(() => {
  ipc.invoke
    .mockReset()
    .mockImplementation(async (command: string) =>
      command === 'export_begin' ? 'token-1' : undefined
    );
  ipc.invokeFile.mockReset().mockResolvedValue(undefined);
});

describe('ExportSession', () => {
  it('sends a file in bounded chunks, opening it with the first', async () => {
    const session = await ExportSession.begin({ kind: 'archive' });
    expect(ipc.invoke).toHaveBeenCalledWith('export_begin', {
      target: { kind: 'archive' }
    });
    const bytes = new Uint8Array(CHUNK_BYTES * 2 + 5).map((_, i) => i % 251);
    await session.write('Work/big.pdf', bytes);

    const calls = ipc.invokeFile.mock.calls;
    expect(calls.map(([, meta]) => meta)).toEqual([
      {
        token: 'token-1',
        path: 'Work/big.pdf',
        first: true,
        size: bytes.length
      },
      {
        token: 'token-1',
        path: 'Work/big.pdf',
        first: false,
        size: bytes.length
      },
      {
        token: 'token-1',
        path: 'Work/big.pdf',
        first: false,
        size: bytes.length
      }
    ]);
    expect(calls.map(([, , chunk]) => (chunk as Uint8Array).length)).toEqual([
      CHUNK_BYTES,
      CHUNK_BYTES,
      5
    ]);
    const joined = new Uint8Array(bytes.length);
    let offset = 0;
    for (const [, , chunk] of calls) {
      joined.set(chunk as Uint8Array, offset);
      offset += (chunk as Uint8Array).length;
    }
    expect(joined).toEqual(bytes);
  });

  it('still opens an empty file', async () => {
    const session = await ExportSession.begin({ kind: 'file' });
    await session.write('empty.typ', new Uint8Array());
    expect(ipc.invokeFile).toHaveBeenCalledOnce();
    expect(ipc.invokeFile.mock.calls[0][1]).toMatchObject({
      first: true,
      size: 0
    });
  });

  it('passes asset copies and save options through', async () => {
    const session = await ExportSession.begin({ kind: 'folder', root: '/x' });
    await session.copyAsset('_assets/a.png', 'asset_a', 'image/png');
    expect(ipc.invoke).toHaveBeenCalledWith('export_copy_asset', {
      token: 'token-1',
      path: '_assets/a.png',
      assetId: 'asset_a',
      mimeType: 'image/png'
    });
    ipc.invoke.mockResolvedValueOnce(false);
    const save = {
      suggestedName: 'x.zip',
      filterName: 'ZIP',
      extensions: ['zip']
    };
    await expect(session.finish(save)).resolves.toBe(false);
    expect(ipc.invoke).toHaveBeenLastCalledWith('export_finish', {
      token: 'token-1',
      save
    });
  });

  it('rejects a malformed finish reply', async () => {
    const session = await ExportSession.begin({ kind: 'archive' });
    ipc.invoke.mockResolvedValueOnce('yes');
    await expect(session.finish()).rejects.toThrow();
  });

  it('never throws from abort', async () => {
    const session = await ExportSession.begin({ kind: 'archive' });
    ipc.invoke.mockRejectedValueOnce(new Error('gone'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(session.abort()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe('exportAssetTypes', () => {
  it('skips the call for no ids and parses the reply', async () => {
    expect(await exportAssetTypes([])).toEqual(new Map());
    expect(ipc.invoke).not.toHaveBeenCalled();
    ipc.invoke.mockResolvedValueOnce({ asset_a: 'image/png' });
    expect(await exportAssetTypes(['asset_a', 'asset_b'])).toEqual(
      new Map([['asset_a', 'image/png']])
    );
  });

  it('rejects a reply that is not a map of strings', async () => {
    ipc.invoke.mockResolvedValueOnce({ asset_a: 3 });
    await expect(exportAssetTypes(['asset_a'])).rejects.toThrow();
  });
});
