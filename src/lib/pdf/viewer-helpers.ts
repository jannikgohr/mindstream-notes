import { PAGE_COLUMN_CLASS } from '$lib/layout/page-layout';
import type {
  PdfAnnotation,
  PdfAnnotationType,
  PdfFormValue,
  PdfRect
} from './types';

export type PdfJs = typeof import('pdfjs-dist');
export type PdfViewer = typeof import('pdfjs-dist/web/pdf_viewer.mjs');
export type PdfDocument = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;
export type PdfPageView = InstanceType<PdfViewer['PDFPageView']>;
export type PdfAnnotationStorage = PdfDocument['annotationStorage'];
export type ZoomMode = 'fixed' | 'fit-width';
export type PdfTool =
  | 'select'
  | 'highlight'
  | 'comment'
  | 'pen'
  | 'signature'
  | 'delete';
export type RenderParams = {
  pageNumber: number;
  version: number;
  zoom: number;
  zoomMode: ZoomMode;
  width: number;
  height: number;
  annotationVersion: number;
  activeTool: PdfTool;
  areaMode: boolean;
  selectedAnnotationId: string | null;
  shouldRender: boolean;
  invalidation: number;
  searchVersion: number;
};
export type PageSize = { width: number; height: number };
export type ZoomAnchor = {
  pageNumber: number;
  xRatio: number;
  yRatio: number;
};
export type PdfViewport = ReturnType<
  Awaited<ReturnType<PdfDocument['getPage']>>['getViewport']
>;
export type PdfLink = {
  rect: number[];
  url?: string;
  dest?: string | unknown[] | null;
};

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;
export const ZOOM_STEP = 1.2;
export const QUICK_ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
export const PDF_PAGE_COLUMN_CLASS = `${PAGE_COLUMN_CLASS} pdf-page-column`;
export const PDF_TO_CSS_UNITS = 96 / 72;
export const MAX_CANVAS_DIM = 16384;
export const MAX_CANVAS_PIXELS = 2 ** 25;
export const SAVE_DEBOUNCE_MS = 800;
export const SEARCH_DEBOUNCE_MS = 220;
export const HIGHLIGHT_COLOR = '#facc15';
export const COMMENT_COLOR = '#3b82f6';
export const SIGNATURE_COLOR = '#111827';
export const INK_COLOR = '#111827';
export const INK_WIDTH = 2.25;
export const ANNOTATION_COLORS = [
  '#facc15',
  '#fb923c',
  '#f87171',
  '#4ade80',
  '#60a5fa',
  '#c084fc',
  '#111827'
];
export const LOCAL_ORIGIN = Symbol('pdf-local-change');
/**
 * Origin tag for a history-version restore. Deliberately distinct from
 * `LOCAL_ORIGIN` so the UndoManager (which tracks only `LOCAL_ORIGIN`) ignores
 * it — a restore is reversed through history, not the per-edit Ctrl+Z stack.
 */
export const HISTORY_RESTORE_ORIGIN = Symbol('pdf-history-restore');
export const RENDER_ROOT_MARGIN = '100% 0%';
export const RENDER_DROP_DELAY_MS = 200;
export const DRAW_KICKOFF_DELAY_MS = 80;

export function pdfAssetIdFromBody(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('asset_')) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const assetId = (parsed as { pdfAssetId?: unknown }).pdfAssetId;
    return typeof assetId === 'string' ? assetId : null;
  } catch {
    return null;
  }
}

export function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

export function clonePdfFormValue(value: unknown): PdfFormValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as PdfFormValue;
  } catch {
    return null;
  }
}

export function buildPdfAnnotation(params: {
  id: string;
  type: PdfAnnotationType;
  pageIndex: number;
  rect: PdfRect | PdfRect[];
  body?: string;
  color: string;
  authorId: string;
  now: string;
  extras?: Partial<Pick<PdfAnnotation, 'strokes' | 'signature'>>;
}): PdfAnnotation {
  const rects = Array.isArray(params.rect) ? params.rect : [params.rect];
  return {
    id: params.id,
    type: params.type,
    pageIndex: params.pageIndex,
    rects,
    color: params.color,
    opacity:
      params.type === 'highlight' ? 0.32 : params.type === 'comment' ? 0.18 : 1,
    authorId: params.authorId,
    createdAt: params.now,
    updatedAt: params.now,
    body: params.body,
    ...params.extras
  };
}

export function isCommentLikeAnnotation(annotation: PdfAnnotation): boolean {
  // A highlight is comment-like once it carries a body string. `undefined`
  // body means a plain highlight, which stays out of the comments sidebar.
  return (
    annotation.type === 'comment' ||
    (annotation.type === 'highlight' && typeof annotation.body === 'string')
  );
}

/**
 * Max pointer travel (px) between pointerdown and pointerup for the
 * gesture to still count as a click on an annotation rather than the
 * start of a text-selection drag.
 */
export const ANNOTATION_CLICK_SLOP_PX = 5;

/**
 * Topmost `.pdf-app-annotation` under a client point. Used by the
 * text-aware tools, where the annotation nodes are pointer-transparent
 * (so drags select the text beneath them) and plain clicks are
 * hit-tested against the rendered rects instead. Later siblings paint
 * on top, so the last match wins.
 */
export function annotationIdAtPoint(
  layer: Element,
  clientX: number,
  clientY: number
): string | null {
  let hit: string | null = null;
  for (const node of layer.querySelectorAll<HTMLElement>(
    '.pdf-app-annotation'
  )) {
    const rect = node.getBoundingClientRect();
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      hit = node.dataset.annotationId ?? hit;
    }
  }
  return hit;
}
