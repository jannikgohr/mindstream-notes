import { A4_PAGE } from '$lib/layout/page-layout';

export interface PageSize {
  width: number;
  height: number;
}

export interface DocumentLayout {
  page: PageSize;
  pageCount: number;
  pageGap: number;
  pages?: InkPage[];
}

export interface InkPage extends PageSize {
  id: string;
  background?: {
    assetId: string;
    pageIndex: number;
    textAssetId?: string;
    /** Absent on legacy PDF backgrounds. Images are already rotated/cropped. */
    kind?: 'image';
    thumbnailAssetId?: string;
    pixelWidth?: number;
    pixelHeight?: number;
    text?: string;
    sourceSignature?: string;
  };
  pdfTransform?: number[];
}

export function layoutForPages(pages: InkPage[]): DocumentLayout {
  return {
    pages,
    page: {
      width: Math.max(1, ...pages.map((page) => page.width)),
      height: Math.max(1, ...pages.map((page) => page.height))
    },
    pageCount: pages.length,
    pageGap: DEFAULT_PAGE_GAP
  };
}

export interface InkPoint {
  x: number;
  y: number;
  pressure: number;
}

// The ink page is A4, defined once in the shared layout module so it
// stays 1:1 with the PDF viewer's A4 page. See A4_PAGE for the maths.
export const DEFAULT_PAGE: PageSize = A4_PAGE;

export const DEFAULT_PAGE_GAP = 72;
export const MIN_PAGE_COUNT = 2;

export function defaultLayout(pageCount = MIN_PAGE_COUNT): DocumentLayout {
  return {
    page: DEFAULT_PAGE,
    pageCount: Math.max(MIN_PAGE_COUNT, pageCount),
    pageGap: DEFAULT_PAGE_GAP
  };
}

export function strideY(layout: DocumentLayout): number {
  return layout.page.height + layout.pageGap;
}

export function documentHeight(layout: DocumentLayout): number {
  if (layout.pages)
    return (
      layout.pages.reduce((sum, page) => sum + page.height, 0) +
      Math.max(0, layout.pages.length - 1) * layout.pageGap
    );
  const pages = Math.max(1, layout.pageCount);
  return layout.page.height * pages + layout.pageGap * (pages - 1);
}

export function pageTop(layout: DocumentLayout, index: number): number {
  if (layout.pages)
    return layout.pages
      .slice(0, index)
      .reduce((sum, page) => sum + page.height + layout.pageGap, 0);
  return index * strideY(layout);
}

export function pageRect(
  layout: DocumentLayout,
  index: number
): [number, number, number, number] | null {
  if (index < 0 || index >= layout.pageCount) return null;
  const top = pageTop(layout, index);
  if (layout.pages) {
    const page = layout.pages[index];
    const left = (layout.page.width - page.width) / 2;
    return [left, top, left + page.width, top + page.height];
  }
  return [0, top, layout.page.width, top + layout.page.height];
}

export function pageIndexAt(
  layout: DocumentLayout,
  x: number,
  y: number
): number | null {
  if (layout.pages) {
    for (let i = 0; i < layout.pages.length; i++) {
      const rect = pageRect(layout, i)!;
      if (x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3])
        return i;
    }
    return null;
  }
  if (x < 0 || x > layout.page.width || y < 0 || y > documentHeight(layout)) {
    return null;
  }
  const stride = strideY(layout);
  if (stride <= 0) return null;
  const index = Math.floor(y / stride);
  if (index >= layout.pageCount) return null;
  const localY = y - pageTop(layout, index);
  return localY <= layout.page.height ? index : null;
}

export function containsPagePoint(
  layout: DocumentLayout,
  x: number,
  y: number
): boolean {
  return pageIndexAt(layout, x, y) !== null;
}

export function pageCountForContentMaxY(maxY: number): number {
  if (!Number.isFinite(maxY) || maxY <= 0) return MIN_PAGE_COUNT;
  const layout = defaultLayout(MIN_PAGE_COUNT);
  const contentPages = Math.floor(maxY / strideY(layout)) + 1;
  return Math.max(MIN_PAGE_COUNT, contentPages + 1);
}

export function pointToSegmentDistanceSq(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) {
    const qx = p.x - a.x;
    const qy = p.y - a.y;
    return qx * qx + qy * qy;
  }
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq)
  );
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  const qx = p.x - cx;
  const qy = p.y - cy;
  return qx * qx + qy * qy;
}
