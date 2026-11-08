import { afterEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => vi.fn());
vi.mock('./export-session', () => ({ saveFileNatively: native }));
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
  native.mockReset();
});

describe('file export save bridge', () => {
  it('stages the file natively with its filter and preserves cancellation', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    native.mockResolvedValue(false);
    expect(await saveFileExport(input)).toBe(false);
    expect(native).toHaveBeenCalledWith({
      suggestedName: 'Cards.csv',
      dialogTitle: undefined,
      filterName: 'CSV',
      extensions: ['csv'],
      bytes: input.bytes
    });
  });

  it('never builds the native byte array in a browser', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const from = vi.spyOn(Array, 'from');
    await saveFileExport(input);
    expect(from).not.toHaveBeenCalledWith(input.bytes);
    expect(native).not.toHaveBeenCalled();
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
