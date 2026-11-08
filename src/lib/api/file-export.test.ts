import { afterEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => vi.fn());
vi.mock('./export-session', () => ({ saveFileNatively: native }));
import { pickBrowserSaveFile, saveFileExport } from './file-export';
const input = {
  suggestedName: 'Cards.csv',
  bytes: new Uint8Array([1, 2, 3]),
  mime: 'text/csv',
  filterName: 'CSV',
  extensions: ['csv']
};

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
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

describe('browser save picker', () => {
  const options = {
    suggestedName: 'vault.zip',
    description: 'ZIP archive',
    mime: 'application/zip',
    extension: '.zip'
  };
  const setPicker = (picker: unknown) => {
    (window as unknown as Record<string, unknown>).showSaveFilePicker = picker;
  };

  it('reports a browser without the picker', async () => {
    expect(await pickBrowserSaveFile(options)).toBeUndefined();
  });

  it('reports a cancelled picker as null', async () => {
    setPicker(async () => {
      throw new DOMException('cancelled', 'AbortError');
    });
    expect(await pickBrowserSaveFile(options)).toBeNull();
  });

  it('rethrows other picker failures', async () => {
    setPicker(async () => {
      throw new DOMException('blocked', 'SecurityError');
    });
    await expect(pickBrowserSaveFile(options)).rejects.toThrow('blocked');
  });

  it('writes through the picked file and never throws from abort', async () => {
    const writable = {
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {
        throw new Error('already closed');
      })
    };
    const picker = vi.fn(async () => ({
      createWritable: async () => writable
    }));
    setPicker(picker);
    const file = await pickBrowserSaveFile(options);
    expect(picker).toHaveBeenCalledWith({
      suggestedName: 'vault.zip',
      types: [
        { description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }
      ]
    });
    const chunk = new Uint8Array([1, 2]);
    await file!.write(chunk);
    await file!.close();
    expect(writable.write).toHaveBeenCalledWith(chunk);
    expect(writable.close).toHaveBeenCalledOnce();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(file!.abort()).resolves.toBeUndefined();
  });
});
