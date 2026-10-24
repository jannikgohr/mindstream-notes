import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { exportFilename, type ExportFile } from './files';

/** Render sequentially and release each canvas before moving to the next page. */
export async function pdfPngFiles(
  bytes: Uint8Array,
  title: string
): Promise<ExportFile[]> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: bytes.slice() });
  try {
    const pdf = await task.promise;
    const files: ExportFile[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      // 144 dpi, capped to avoid allocating enormous canvases for oversized PDFs.
      const scale = Math.min(
        2,
        8192 / Math.max(base.width, base.height),
        Math.sqrt(24_000_000 / (base.width * base.height))
      );
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      try {
        await page.render({ canvas, viewport, background: '#ffffff' }).promise;
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (result) =>
              result
                ? resolve(result)
                : reject(new Error('Could not encode the PNG page.')),
            'image/png'
          )
        );
        files.push({
          name: exportFilename(
            `${title} - ${String(pageNumber).padStart(3, '0')}`,
            'png'
          ),
          format: 'png',
          bytes: new Uint8Array(await blob.arrayBuffer())
        });
      } finally {
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
      }
    }
    return files;
  } finally {
    await task.destroy();
  }
}
