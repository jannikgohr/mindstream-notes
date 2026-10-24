import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import type { PdfAnnotation } from '$lib/pdf/types';

function plainLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/([\\`*_[\]<>#])/g, '\\$1');
}

export async function annotationsMarkdown(
  title: string,
  bytes: Uint8Array,
  annotations: PdfAnnotation[]
): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const lines = [`# ${plainLine(title)}`, ''];
  try {
    const pdf = await task.promise;
    const active = annotations
      .filter(
        (entry) =>
          !entry.deletedAt &&
          (entry.type === 'highlight' || entry.type === 'comment')
      )
      .sort(
        (a, b) =>
          a.pageIndex - b.pageIndex ||
          (b.rects[0]?.y ?? 0) - (a.rects[0]?.y ?? 0) ||
          a.id.localeCompare(b.id)
      );
    let currentPage = -1;
    for (const entry of active) {
      if (entry.pageIndex < 0 || entry.pageIndex >= pdf.numPages) continue;
      if (entry.pageIndex !== currentPage) {
        currentPage = entry.pageIndex;
        lines.push(`## Page ${currentPage + 1}`, '');
      }
      lines.push(
        `### ${entry.type === 'highlight' ? 'Highlight' : 'Comment'}${entry.resolved ? ' (resolved)' : ''}`,
        ''
      );
      if (entry.type === 'highlight') {
        const page = await pdf.getPage(entry.pageIndex + 1);
        const content = await page.getTextContent();
        const matches = content.items
          .filter((item) => {
            if (!('str' in item) || !item.str.trim()) return false;
            const x = item.transform[4];
            const y = item.transform[5];
            const height = Math.abs(item.height);
            return entry.rects.some(
              (rect) =>
                x < rect.x + rect.width &&
                x + item.width > rect.x &&
                y < rect.y + rect.height &&
                y + height > rect.y
            );
          })
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .trim();
        if (matches) lines.push(`> ${plainLine(matches)}`, '');
        page.cleanup();
      }
      if (entry.body?.trim()) lines.push(entry.body, '');
    }
    if (!active.length) lines.push('No highlights or comments.', '');
    return lines.join('\n');
  } finally {
    await task.destroy();
  }
}
