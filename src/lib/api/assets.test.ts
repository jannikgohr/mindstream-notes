import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  fetchAssetBytes,
  importPdfNoteBytes,
  uploadDrawingAssetBytes
} from './assets';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const summary = {
  id: 'asset_pdf',
  owning_note_id: 'note_1',
  mime_type: 'application/pdf',
  size: 4,
  created: '2026-10-19',
  modified: '2026-10-19',
  pushed: false
};

beforeEach(() => {
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.mocked(invoke).mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('binary PDF asset IPC', () => {
  it('sends byte-exact uploads in a binary envelope and receives only metadata', async () => {
    vi.mocked(invoke).mockResolvedValue(summary);
    const bytes = new Uint8Array([0, 37, 128, 255]);
    expect(
      await uploadDrawingAssetBytes({
        owning_note_id: 'note_1',
        mime_type: 'application/pdf',
        bytes
      })
    ).toEqual(summary);
    const [command, raw] = vi.mocked(invoke).mock.calls[0];
    expect(command).toBe('upload_asset_bytes');
    expect(raw).toBeInstanceOf(Uint8Array);
    const payload = raw as Uint8Array;
    const length = new DataView(payload.buffer).getUint32(0, true);
    expect(
      JSON.parse(new TextDecoder().decode(payload.subarray(4, 4 + length)))
    ).toEqual({ owning_note_id: 'note_1', mime_type: 'application/pdf' });
    expect(payload.subarray(4 + length)).toEqual(bytes);
  });

  it('encodes non-ASCII PDF titles without putting file bytes in JSON', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('stop after capture'));
    await expect(
      importPdfNoteBytes({
        title: 'Grüße 日本語',
        parent_collection_id: null,
        bytes: new Uint8Array([255])
      })
    ).rejects.toThrow('stop after capture');
    const [command, raw] = vi.mocked(invoke).mock.calls[0];
    expect(command).toBe('import_pdf_note_bytes');
    const payload = raw as Uint8Array;
    const length = new DataView(payload.buffer).getUint32(0, true);
    expect(
      JSON.parse(new TextDecoder().decode(payload.subarray(4, 4 + length)))
    ).toEqual({ title: 'Grüße 日本語', parent_collection_id: null });
    expect(payload.subarray(4 + length)).toEqual(new Uint8Array([255]));
  });

  it('accepts binary replies and the mobile bridge array fallback', async () => {
    const bytes = new Uint8Array([0, 128, 255]);
    vi.mocked(invoke)
      .mockResolvedValueOnce(bytes.buffer)
      .mockResolvedValueOnce(Array.from(bytes));
    expect(await fetchAssetBytes('asset_pdf', 'application/pdf')).toEqual(
      bytes
    );
    expect(await fetchAssetBytes('asset_pdf')).toEqual(bytes);
    expect(invoke).toHaveBeenNthCalledWith(1, 'fetch_asset_bytes', {
      id: 'asset_pdf',
      mimeType: 'application/pdf'
    });
  });
});
