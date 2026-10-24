import { afterEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { saveFileExport } from './file-export';
const input = {
  suggestedName: 'Cards.csv',
  bytes: new Uint8Array([1, 2, 3]),
  mime: 'text/csv',
  filterName: 'CSV',
  extensions: ['csv']
};

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe('file export save bridge', () => {
  it('passes the correct native filter and preserves cancellation', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue(false);
    expect(await saveFileExport(input)).toBe(false);
    expect(invoke).toHaveBeenCalledWith('save_file_export', {
      input: {
        suggestedName: 'Cards.csv',
        dialogTitle: undefined,
        bytes: [1, 2, 3],
        filterName: 'CSV',
        extensions: ['csv']
      }
    });
  });

  it('downloads with the requested MIME type and filename in a browser', async () => {
    const create = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:test');
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.download).toBe('Cards.csv');
        expect(this.href).toBe('blob:test');
      });
    expect(await saveFileExport(input)).toBe(true);
    expect((create.mock.calls[0][0] as Blob).type).toBe('text/csv');
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
