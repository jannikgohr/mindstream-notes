import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args)
}));

import { pdfNoteNeedsText, pdfNotesMissingText, setPdfText } from './pdf-text';

function setTauri(on: boolean): void {
  if (on)
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  else
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

describe('pdf-text — browser fallback (mock store)', () => {
  it('setPdfText resolves without a backend', async () => {
    await expect(setPdfText('n1', 'hello')).resolves.toBeUndefined();
  });
  it('pdfNotesMissingText resolves to an array', async () => {
    await expect(pdfNotesMissingText()).resolves.toBeInstanceOf(Array);
  });
  it('pdfNoteNeedsText resolves to a boolean', async () => {
    await expect(typeof (await pdfNoteNeedsText('n1'))).toBe('boolean');
  });
});

describe('pdf-text — Tauri (validation path)', () => {
  beforeEach(() => {
    setTauri(true);
    invoke.mockReset();
  });
  afterEach(() => setTauri(false));

  it('setPdfText forwards args and accepts a void response', async () => {
    invoke.mockResolvedValue(undefined);
    await expect(setPdfText('n1', 'body')).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('set_pdf_text', {
      noteId: 'n1',
      text: 'body'
    });
  });

  it('setPdfText rejects a non-void response', async () => {
    invoke.mockResolvedValue('unexpected');
    await expect(setPdfText('n1', 'x')).rejects.toThrow(
      /must not return a value/
    );
  });

  it('pdfNotesMissingText parses a string array and rejects non-arrays', async () => {
    invoke.mockResolvedValueOnce(['a', 'b']);
    await expect(pdfNotesMissingText()).resolves.toEqual(['a', 'b']);
    invoke.mockResolvedValueOnce('nope');
    await expect(pdfNotesMissingText()).rejects.toThrow(/must be an array/);
  });

  it('pdfNoteNeedsText parses a boolean and rejects non-booleans', async () => {
    invoke.mockResolvedValueOnce(true);
    await expect(pdfNoteNeedsText('n1')).resolves.toBe(true);
    invoke.mockResolvedValueOnce('yes');
    await expect(pdfNoteNeedsText('n1')).rejects.toThrow(/must be a boolean/);
  });
});
