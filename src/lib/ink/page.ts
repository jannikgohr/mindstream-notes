export interface PageSize {
  width: number;
  height: number;
}

export interface DocumentLayout {
  page: PageSize;
  pageCount: number;
  pageGap: number;
}

export interface InkPoint {
  x: number;
  y: number;
  pressure: number;
}

export const DEFAULT_PAGE: PageSize = {
  width: 1190,
  height: 1684
};

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
  const pages = Math.max(1, layout.pageCount);
  return layout.page.height * pages + layout.pageGap * (pages - 1);
}

export function pageTop(layout: DocumentLayout, index: number): number {
  return index * strideY(layout);
}

export function pageRect(
  layout: DocumentLayout,
  index: number
): [number, number, number, number] | null {
  if (index < 0 || index >= layout.pageCount) return null;
  const top = pageTop(layout, index);
  return [0, top, layout.page.width, top + layout.page.height];
}

export function pageIndexAt(
  layout: DocumentLayout,
  x: number,
  y: number
): number | null {
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
