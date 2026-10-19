import * as Y from 'yjs';
import {
  DEFAULT_PAGE,
  layoutForPages,
  pageRect,
  type InkPage,
  type InkPoint
} from './page';

export const INK_PAGES = 'ink:pages';
export const INK_PAGE_ORDER = 'ink:pageOrder';
export const INK_DELETED_PAGES = 'ink:deletedPages';
export const INK_META = 'ink:meta';
export const INK_SCHEMA = 2;

export function readPages(doc: Y.Doc): InkPage[] {
  const pages = doc.getMap<InkPage>(INK_PAGES);
  const order = doc.getMap<number>(INK_PAGE_ORDER);
  const deleted = doc.getMap<boolean>(INK_DELETED_PAGES);
  return [...pages.values()]
    .filter(
      (p) =>
        p &&
        typeof p.id === 'string' &&
        Number.isFinite(p.width) &&
        p.width > 0 &&
        Number.isFinite(p.height) &&
        p.height > 0 &&
        deleted.get(p.id) !== true
    )
    .sort(
      (a, b) =>
        (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0) ||
        a.id.localeCompare(b.id)
    );
}

export function legacyPages(count: number): InkPage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `legacy-page-${i}`,
    ...DEFAULT_PAGE
  }));
}

export function pageOffset(
  pages: InkPage[],
  id: string
): { x: number; y: number } | null {
  const index = pages.findIndex((p) => p.id === id);
  if (index < 0) return null;
  const rect = pageRect(layoutForPages(pages), index)!;
  return { x: rect[0], y: rect[1] };
}

/** Clip a polyline to a page, interpolating pressure at its edges. */
export function clipPoints(points: InkPoint[], rect: number[]): InkPoint[][] {
  if (points.length === 1) {
    const p = points[0];
    return p.x >= rect[0] && p.x <= rect[2] && p.y >= rect[1] && p.y <= rect[3]
      ? [[p]]
      : [];
  }
  const result: InkPoint[][] = [];
  let run: InkPoint[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    const dx = b.x - a.x,
      dy = b.y - a.y;
    let start = 0,
      end = 1,
      outside = false;
    const ps = [-dx, dx, -dy, dy];
    const qs = [a.x - rect[0], rect[2] - a.x, a.y - rect[1], rect[3] - a.y];
    for (let j = 0; j < 4; j++) {
      if (ps[j] === 0) {
        if (qs[j] < 0) outside = true;
      } else if (ps[j] < 0) start = Math.max(start, qs[j] / ps[j]);
      else end = Math.min(end, qs[j] / ps[j]);
    }
    if (outside || start > end) {
      if (run.length) result.push(run);
      run = [];
      continue;
    }
    const at = (t: number): InkPoint => ({
      x: a.x + dx * t,
      y: a.y + dy * t,
      pressure: a.pressure + (b.pressure - a.pressure) * t
    });
    const first = at(start),
      last = at(end);
    const previous = run.at(-1);
    if (
      previous &&
      (Math.abs(previous.x - first.x) > 0.001 ||
        Math.abs(previous.y - first.y) > 0.001)
    ) {
      result.push(run);
      run = [];
    }
    if (!run.length) run.push(first);
    run.push(last);
    if (end < 1) {
      result.push(run);
      run = [];
    }
  }
  if (run.length) result.push(run);
  return result;
}
