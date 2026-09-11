import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { createPdfSearchController } from './search-controller';

function page(text: string) {
  return {
    getTextContent: vi.fn(async () => ({
      items: [
        { str: text, transform: [1, 0, 0, 1, 0, 10], width: 100, height: 10 }
      ]
    }))
  } as unknown as PDFPageProxy;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('PDF search controller', () => {
  it('debounces queries and caches page text until the document changes', async () => {
    const getPage = vi.fn(async () => page('alpha beta'));
    let doc = { numPages: 1, getPage } as unknown as PDFDocumentProxy;
    const onResults = vi.fn();
    const controller = createPdfSearchController({
      getDocument: () => doc,
      onResults,
      onBusy: vi.fn(),
      delayMs: 100
    });
    controller.search('missing');
    controller.search('alpha');
    await vi.advanceTimersByTimeAsync(100);
    expect(onResults.mock.lastCall?.[0]).toHaveLength(1);
    controller.search('beta');
    await vi.advanceTimersByTimeAsync(100);
    expect(getPage).toHaveBeenCalledTimes(1);
    doc = {
      numPages: 1,
      getPage: vi.fn(async () => page('different'))
    } as unknown as PDFDocumentProxy;
    controller.search('alpha');
    await vi.advanceTimersByTimeAsync(100);
    expect(onResults).toHaveBeenLastCalledWith([]);
    expect(doc.getPage).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('discards a late page lookup after a newer query and after teardown', async () => {
    let resolve!: (value: PDFPageProxy) => void;
    const getPage = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<PDFPageProxy>((r) => {
          resolve = r;
        })
      )
      .mockResolvedValue(page('new query'));
    const doc = { numPages: 1, getPage } as unknown as PDFDocumentProxy;
    const onResults = vi.fn();
    const onBusy = vi.fn();
    const controller = createPdfSearchController({
      getDocument: () => doc,
      onResults,
      onBusy,
      delayMs: 100
    });
    controller.search('old');
    await vi.advanceTimersByTimeAsync(100);
    controller.search('new');
    await vi.advanceTimersByTimeAsync(100);
    expect(onResults.mock.lastCall?.[0]).toHaveLength(1);
    controller.destroy();
    const calls = onResults.mock.calls.length;
    resolve(page('old'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onResults).toHaveBeenCalledTimes(calls);
    expect(onBusy).toHaveBeenLastCalledWith(false);
  });
});
