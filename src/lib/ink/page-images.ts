import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { uploadDrawingAssetBytes } from '$lib/api/assets';
import type { InkPage } from './page';

export type PageImageProgress = (completed: number, total: number) => void;

/** 216 dpi for ordinary pages, bounded for unusually large PDF sheets. */
export function pageImageScale(width: number, height: number): number {
  return Math.min(
    3,
    Math.sqrt(6_000_000 / (width * height)),
    4096 / Math.max(width, height)
  );
}

function jpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error('Could not compress PDF page.')),
      'image/jpeg',
      quality
    )
  );
}

/**
 * Rendering and text extraction happen once, before this page enters an ink
 * note. With `inkWidth` the page is scaled to that width, keeping its aspect
 * ratio; without it the page keeps its PDF size (ink units are twice points).
 */
export async function savePageImage(
  source: PDFPageProxy,
  pageIndex: number,
  noteId: string,
  signal?: AbortSignal,
  inkWidth?: number
): Promise<InkPage> {
  signal?.throwIfAborted();
  const base = source.getViewport({ scale: 1 });
  const inkScale = inkWidth ? inkWidth / base.width : 2;
  // Rasterize for the size the page is shown at, so an enlarged small page
  // stays as sharp as a page imported at its own size.
  const shown = inkScale / 2;
  const viewport = source.getViewport({
    scale: shown * pageImageScale(base.width * shown, base.height * shown)
  });
  const ink = source.getViewport({ scale: inkScale });
  const canvas = document.createElement('canvas');
  const thumbnail = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('PDF canvas is unavailable.');
  const task = source.render({
    canvas,
    canvasContext: ctx,
    viewport,
    background: '#ffffff'
  });
  const cancel = () => task.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    await task.promise;
    signal?.throwIfAborted();
    const scale = Math.min(1, 256 / Math.max(canvas.width, canvas.height));
    thumbnail.width = Math.max(1, Math.round(canvas.width * scale));
    thumbnail.height = Math.max(1, Math.round(canvas.height * scale));
    thumbnail
      .getContext('2d')!
      .drawImage(canvas, 0, 0, thumbnail.width, thumbnail.height);
    const imageBlob = await jpeg(canvas, 0.9);
    const previewBlob = await jpeg(thumbnail, 0.8);
    const content = await source.getTextContent();
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');
    signal?.throwIfAborted();
    const asset = await uploadDrawingAssetBytes({
      owning_note_id: noteId,
      mime_type: 'image/jpeg',
      bytes: new Uint8Array(await imageBlob.arrayBuffer())
    });
    const preview = await uploadDrawingAssetBytes({
      owning_note_id: noteId,
      mime_type: 'image/jpeg',
      bytes: new Uint8Array(await previewBlob.arrayBuffer())
    });
    return {
      id: `page_${crypto.randomUUID()}`,
      width: ink.width,
      height: ink.height,
      pdfTransform: ink.transform,
      background: {
        kind: 'image',
        assetId: asset.id,
        thumbnailAssetId: preview.id,
        pageIndex,
        pixelWidth: canvas.width,
        pixelHeight: canvas.height,
        text
      }
    };
  } finally {
    signal?.removeEventListener('abort', cancel);
    canvas.width = canvas.height = thumbnail.width = thumbnail.height = 0;
    // Release decoded source images before rasterizing the next page.
    source.cleanup();
  }
}

export async function savePdfPageImages(
  doc: PDFDocumentProxy,
  indices: number[],
  noteId: string,
  progress?: PageImageProgress,
  signal?: AbortSignal,
  inkWidth?: number
): Promise<InkPage[]> {
  const result: InkPage[] = [];
  progress?.(0, indices.length);
  for (const index of indices) {
    signal?.throwIfAborted();
    result.push(
      await savePageImage(
        await doc.getPage(index + 1),
        index,
        noteId,
        signal,
        inkWidth
      )
    );
    progress?.(result.length, indices.length);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return result;
}
