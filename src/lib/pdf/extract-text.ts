import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

type PdfJs = typeof import('pdfjs-dist');

let pdfjsPromise: Promise<PdfJs> | null = null;

async function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    return pdfjs;
  });
  return pdfjsPromise;
}

/**
 * Minimal shape of a loaded pdf.js document we need for text extraction.
 * `items` is left as `unknown[]` so a real `PDFDocumentProxy` (whose text
 * items are `TextItem | TextMarkedContent`) is assignable — marked-content
 * items carry no `str` and are filtered out below.
 */
interface PdfDocumentLike {
  numPages: number;
  getPage: (pageNumber: number) => Promise<{
    getTextContent: () => Promise<{ items: ReadonlyArray<unknown> }>;
  }>;
}

function itemText(item: unknown): string {
  return item && typeof item === 'object' && 'str' in item
    ? String((item as { str?: unknown }).str ?? '')
    : '';
}

/**
 * Concatenate the text of every page of an already-loaded pdf.js document
 * (pages separated by a blank line). Use this when a document is already
 * open — e.g. the viewer — to avoid parsing the PDF a second time.
 */
export async function extractTextFromDocument(
  doc: PdfDocumentLike
): Promise<string> {
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map(itemText).filter(Boolean).join(' ');
    if (text.trim()) pages.push(text);
  }
  return pages.join('\n\n');
}

/** Extract all text from raw PDF bytes, opening (and disposing) a document. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  try {
    return await extractTextFromDocument(doc);
  } finally {
    await task.destroy();
  }
}
