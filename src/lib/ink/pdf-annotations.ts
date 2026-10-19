import { InkDocument } from './document';
import type { PdfAnnotation } from '$lib/pdf/types';

/** Adapt shared ink to the existing PDF reader/exporter without changing legacy annotations. */
export function sharedInkAnnotations(
  bytes: Uint8Array | number[]
): PdfAnnotation[] {
  const ink = InkDocument.fromBytes(bytes);
  try {
    return ink.pages().flatMap((page, pageIndex) =>
      ink.pageStrokes(page.id).map((stroke): PdfAnnotation => {
        const [a, b, c, d, e, f] = page.pdfTransform ?? [
          2,
          0,
          0,
          -2,
          0,
          page.height
        ];
        const determinant = a * d - b * c;
        const points = stroke.points.map((p) => ({
          x: (d * (p.x - e) - c * (p.y - f)) / determinant,
          y: (-b * (p.x - e) + a * (p.y - f)) / determinant,
          pressure: p.pressure
        }));
        const bounds = points.reduce(
          (bounds, point) => ({
            minX: Math.min(bounds.minX, point.x),
            minY: Math.min(bounds.minY, point.y),
            maxX: Math.max(bounds.maxX, point.x),
            maxY: Math.max(bounds.maxY, point.y)
          }),
          { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
        );
        const padding = stroke.width / 2;
        return {
          id: `shared:${stroke.id}`,
          type: 'ink',
          pageIndex,
          rects: [
            {
              x: bounds.minX - padding,
              y: bounds.minY - padding,
              width: bounds.maxX - bounds.minX + padding * 2,
              height: bounds.maxY - bounds.minY + padding * 2
            }
          ],
          color: `#${(stroke.color & 0xffffff).toString(16).padStart(6, '0')}`,
          opacity: (stroke.color >>> 24) / 255,
          authorId: 'local',
          createdAt: '',
          updatedAt: '',
          strokes: [
            {
              id: stroke.id,
              points,
              width: stroke.width / 2,
              color: `#${(stroke.color & 0xffffff).toString(16).padStart(6, '0')}`
            }
          ]
        };
      })
    );
  } finally {
    ink.doc.destroy();
  }
}
