import {
  buildPageTextIndex,
  findMatchesInPage,
  type PageTextIndex,
  type PdfSearchMatch
} from './pdf-text-index';
import type { PDFDocumentProxy } from 'pdfjs-dist';

export function createPdfSearchController(options: {
  getDocument: () => PDFDocumentProxy | null;
  onResults: (matches: PdfSearchMatch[]) => void;
  onBusy: (busy: boolean) => void;
  delayMs: number;
}) {
  let generation = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cachedDocument: PDFDocumentProxy | null = null;
  const cache = new Map<number, PageTextIndex>();
  function cancel() {
    generation += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    options.onBusy(false);
  }
  async function run(query: string, token: number): Promise<void> {
    const doc = options.getDocument();
    const current = () =>
      !disposed && token === generation && doc === options.getDocument();
    if (!query.trim() || !doc) {
      options.onResults([]);
      return;
    }
    if (cachedDocument !== doc) {
      cache.clear();
      cachedDocument = doc;
    }
    options.onBusy(true);
    const matches: PdfSearchMatch[] = [];
    try {
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
        let index = cache.get(pageNumber - 1);
        if (!index) {
          const page = await doc.getPage(pageNumber);
          if (!current()) return;
          index = await buildPageTextIndex(page);
          if (!current()) return;
          cache.set(pageNumber - 1, index);
        }
        matches.push(...findMatchesInPage(index, pageNumber - 1, query.trim()));
      }
      if (current()) options.onResults(matches);
    } catch (error) {
      if (current()) {
        console.warn('[pdf] text search failed', error);
        options.onResults([]);
      }
    } finally {
      if (current()) options.onBusy(false);
    }
  }
  return {
    search(query: string) {
      cancel();
      if (disposed) return;
      const token = generation;
      timer = setTimeout(() => {
        timer = null;
        void run(query, token);
      }, options.delayMs);
    },
    clear() {
      cancel();
      options.onResults([]);
    },
    destroy() {
      disposed = true;
      cancel();
      cache.clear();
      cachedDocument = null;
    }
  };
}
