import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { fetchAssetBytes } from '$lib/api/assets';
import { loadNote } from '$lib/api/notes';
import type { InkPage } from './page';
import { cachedPdfPageText, pdfNoteNeedsText } from '$lib/api/pdf-text';
import { savePdfPageImages, type PageImageProgress } from './page-images';

export function backgroundSignature(pages: InkPage[]): string {
  return JSON.stringify(
    pages
      .filter((p) => p.background)
      .map((p) => [
        p.id,
        p.background!.textAssetId ?? p.background!.assetId,
        p.background!.pageIndex
      ])
  );
}

async function pdfLibrary() {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  return pdfjs;
}

export async function openPdf(bytes: Uint8Array) {
  const pdfjs = await pdfLibrary();
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  return Object.assign(doc, { destroy: () => task.destroy() });
}

async function pageMetadata(
  doc: PDFDocumentProxy,
  indices: number[]
): Promise<InkPage[]> {
  const result: InkPage[] = [];
  for (const i of indices) {
    // Ink units are twice PDF points, preserving the existing A4 ink scale.
    const viewport = (await doc.getPage(i + 1)).getViewport({ scale: 2 });
    result.push({
      id: `page_${crypto.randomUUID()}`,
      width: viewport.width,
      height: viewport.height,
      pdfTransform: viewport.transform
    });
  }
  return result;
}

/** Keep the parsed file open between page selection and insertion. */
export async function preparePdfImport(file: File) {
  const pdfjs = await pdfLibrary();
  const url = URL.createObjectURL(file);
  const task = pdfjs.getDocument({ url });
  try {
    const doc = await task.promise;
    let closing: Promise<void> | undefined;
    return {
      file,
      pageCount: doc.numPages,
      pages: (indices: number[]) => pageMetadata(doc, indices),
      images: (
        indices: number[],
        noteId: string,
        progress?: PageImageProgress,
        signal?: AbortSignal
      ) => savePdfPageImages(doc, indices, noteId, progress, signal),
      destroy() {
        return (closing ??= task
          .destroy()
          .finally(() => URL.revokeObjectURL(url)));
      }
    };
  } catch (error) {
    await task.destroy();
    URL.revokeObjectURL(url);
    throw error;
  }
}

export type PreparedPdfImport = Awaited<ReturnType<typeof preparePdfImport>>;

export async function pdfPages(bytes: Uint8Array): Promise<InkPage[]> {
  const doc = await openPdf(bytes);
  try {
    return await pageMetadata(
      doc,
      Array.from({ length: doc.numPages }, (_, i) => i)
    );
  } finally {
    await doc.destroy();
  }
}

/** A bounded render cache per editor; PDF work never blocks pointer handlers. */
export function createPdfBackgroundCache(
  changed: () => void,
  failed: (error: unknown) => void
) {
  const sources = new Map<
    string,
    Promise<Awaited<ReturnType<typeof openPdf>>>
  >();
  const images = new Map<
    string,
    { scale: number; canvas: HTMLCanvasElement }
  >();
  const pending = new Set<string>();
  const previews = new Map<string, HTMLCanvasElement>();
  const wanted = new Set<string>();
  const renders = new Map<string, { cancel(): void }>();
  let closed = false;
  async function loadImage(id: string): Promise<HTMLCanvasElement> {
    const bytes = await fetchAssetBytes(id, 'image/jpeg');
    const bitmap = await createImageBitmap(
      new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })
    );
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
      return canvas;
    } finally {
      bitmap.close();
    }
  }
  function trimImages() {
    let pixels = [...images.values()].reduce(
      (sum, entry) => sum + entry.canvas.width * entry.canvas.height,
      0
    );
    for (const [key, entry] of images) {
      if (images.size <= 8 && pixels <= 24_000_000) break;
      if (wanted.has(key)) continue;
      pixels -= entry.canvas.width * entry.canvas.height;
      images.delete(key);
    }
  }
  const documentFor = (assetId: string) => {
    let source = sources.get(assetId);
    if (!source) {
      source = fetchAssetBytes(assetId, 'application/pdf').then(openPdf);
      sources.set(assetId, source);
      void source.catch(() => sources.delete(assetId));
    }
    return source;
  };
  return {
    beginFrame() {
      wanted.clear();
    },
    endFrame() {
      for (const [key, task] of renders) if (!wanted.has(key)) task.cancel();
      trimImages();
      for (const [assetId, source] of sources) {
        if (
          [...wanted, ...pending].some((key) => key.startsWith(`${assetId}:`))
        )
          continue;
        sources.delete(assetId);
        void source.then((doc) => doc.destroy()).catch(() => {});
      }
    },
    get(page: InkPage, scale: number): HTMLCanvasElement | null {
      if (!page.background || closed) return null;
      if (page.background.kind === 'image') {
        const { assetId, thumbnailAssetId } = page.background;
        const usePreview =
          scale * Math.max(page.width, page.height) <= 300 && thumbnailAssetId;
        const id = usePreview || assetId;
        const key = `image:${id}`;
        wanted.add(key);
        const hit = images.get(key);
        if (hit) {
          images.delete(key);
          images.set(key, hit);
          return hit.canvas;
        }
        if (usePreview && previews.has(id)) return previews.get(id)!;
        if (
          thumbnailAssetId &&
          !previews.has(thumbnailAssetId) &&
          !pending.has(thumbnailAssetId)
        ) {
          pending.add(thumbnailAssetId);
          void loadImage(thumbnailAssetId)
            .then((canvas) => {
              if (closed) return;
              previews.set(thumbnailAssetId, canvas);
              while (previews.size > 128)
                previews.delete(previews.keys().next().value!);
              changed();
            })
            .catch((error) => {
              if (!closed) failed(error);
            })
            .finally(() => pending.delete(thumbnailAssetId));
        }
        if (!usePreview && !pending.has(key)) {
          pending.add(key);
          void loadImage(id)
            .then((canvas) => {
              if (closed) return;
              images.set(key, { scale: Infinity, canvas });
              trimImages();
              changed();
            })
            .catch((error) => {
              if (!closed) failed(error);
            })
            .finally(() => pending.delete(key));
        }
        return (thumbnailAssetId && previews.get(thumbnailAssetId)) || null;
      }
      const { assetId, pageIndex } = page.background;
      const key = `${assetId}:${pageIndex}`;
      wanted.add(key);
      const cached = images.get(key);
      const desired = Math.min(
        2,
        Math.max(0.25, Math.ceil(scale * 4) / 4),
        Math.sqrt(4_000_000 / (page.width * page.height))
      );
      if ((!cached || cached.scale < desired * 0.9) && !pending.has(key)) {
        pending.add(key);
        void (async () => {
          try {
            const doc = await documentFor(assetId);
            if (closed || !wanted.has(key)) return;
            const source = await doc.getPage(pageIndex + 1);
            if (closed || !wanted.has(key)) return;
            const viewport = source.getViewport({ scale: desired * 2 });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const context = canvas.getContext('2d');
            if (!context)
              throw new Error('PDF background canvas is unavailable.');
            const task = source.render({
              canvasContext: context,
              canvas,
              viewport
            });
            renders.set(key, task);
            await task.promise;
            if (closed) return;
            images.delete(key);
            images.set(key, { scale: desired, canvas });
            while (images.size > 8) images.delete(images.keys().next().value!);
            changed();
          } catch (error) {
            if (
              !closed &&
              !(
                error instanceof Error &&
                error.name === 'RenderingCancelledException'
              )
            )
              failed(error);
          } finally {
            renders.delete(key);
            pending.delete(key);
          }
        })();
      }
      return cached?.canvas ?? null;
    },
    destroy() {
      closed = true;
      for (const task of renders.values()) task.cancel();
      renders.clear();
      images.clear();
      previews.clear();
      for (const source of sources.values())
        void source.then((doc) => doc.destroy()).catch(() => {});
      sources.clear();
    }
  };
}

const pageText = new Map<string, string>();
export async function extractInkBackgroundText(
  pages: InkPage[]
): Promise<string> {
  const text = new Map<string, string>();
  for (const page of pages)
    if (page.background?.kind === 'image')
      text.set(page.id, page.background.text ?? '');
  const assets = [
    ...new Set(
      pages.flatMap((p) =>
        p.background && p.background.kind !== 'image'
          ? [p.background.textAssetId ?? p.background.assetId]
          : []
      )
    )
  ];
  for (const assetId of assets) {
    const relevant = pages.filter(
      (p) =>
        p.background &&
        (p.background.textAssetId ?? p.background.assetId) === assetId
    );
    for (const page of relevant) {
      const key = `${assetId}:${page.background!.pageIndex}`;
      if (!pageText.has(key)) {
        const cached = await cachedPdfPageText(
          assetId,
          page.background!.pageIndex
        );
        if (cached !== null) pageText.set(key, cached);
      }
    }
    const missing = relevant.filter(
      (p) => !pageText.has(`${assetId}:${p.background!.pageIndex}`)
    );
    if (missing.length) {
      const pdf = await openPdf(
        await fetchAssetBytes(assetId, 'application/pdf')
      );
      try {
        for (const page of missing) {
          const source = await pdf.getPage(page.background!.pageIndex + 1);
          const content = await source.getTextContent();
          const value = content.items
            .map((item) => ('str' in item ? item.str : ''))
            .join(' ');
          pageText.set(`${assetId}:${page.background!.pageIndex}`, value);
          await cachedPdfPageText(assetId, page.background!.pageIndex, value);
        }
      } finally {
        await pdf.destroy();
      }
    }
    for (const page of relevant)
      text.set(
        page.id,
        pageText.get(`${assetId}:${page.background!.pageIndex}`) ?? ''
      );
  }
  const result = pages
    .map((p) => text.get(p.id) ?? '')
    .filter(Boolean)
    .join('\n\n');
  while (pageText.size > 256) pageText.delete(pageText.keys().next().value!);
  return result;
}

export async function indexInkNote(noteId: string): Promise<void> {
  if (!(await pdfNoteNeedsText(noteId))) return;
  const { InkDocument } = await import('./document');
  const { setPdfText } = await import('$lib/api/pdf-text');
  const note = await loadNote(noteId);
  if (note.note_kind !== 'ink') return;
  const ink = InkDocument.fromBytes(note.yrs_state);
  try {
    const pages = ink.pages();
    const signature = backgroundSignature(pages);
    const text = await extractInkBackgroundText(pages);
    await setPdfText(noteId, text, signature);
  } finally {
    ink.doc.destroy();
  }
}
