/**
 * The per-page render action for the PDF viewer.
 *
 * One instance is attached to every page surface. It owns that page's
 * pdf.js `PDFPageView`, the debounced draw scheduling that keeps the
 * single pdf.js worker from being swamped during fast scroll, and the
 * three overlays drawn on top of the canvas: search hits, link
 * annotations, and our own annotations (highlights, comments, ink,
 * signatures).
 *
 * It reads and mutates a lot of viewer state, which arrives as an
 * explicit [`PageRenderContext`] rather than a closure over the
 * component — that is what lets this live outside PdfNoteViewer.svelte.
 */

import { tUi } from '$lib/settings/i18n.svelte';
import { listen } from '$lib/api/events';
import type { FlatOutlineItem } from '$lib/pdf/outline';
import type { PdfSearchMatch } from '$lib/pdf/pdf-text-index';
import {
  cloneSignatureSnapshot,
  strokeBounds,
  strokeOutlinePath,
  strokePointsAttr
} from '$lib/pdf/stroke-utils';
import type {
  PdfAnnotation,
  PdfAnnotationType,
  PdfRect,
  PdfSignatureSnapshot,
  PdfStrokePoint
} from '$lib/pdf/types';
import { PAGE_FIT_MARGIN } from '$lib/layout/page-layout';
import { createPageOverlays } from './page-overlays';
import {
  ANNOTATION_CLICK_SLOP_PX,
  DRAW_KICKOFF_DELAY_MS,
  INK_WIDTH,
  MAX_CANVAS_DIM,
  MAX_CANVAS_PIXELS,
  PDF_TO_CSS_UNITS,
  annotationIdAtPoint,
  clampZoom,
  type PageSize,
  type PdfDocument,
  type PdfJs,
  type PdfLink,
  type PdfPageView,
  type PdfTool,
  type PdfViewer,
  type PdfViewport,
  type RenderParams,
  type ZoomMode
} from '$lib/pdf/viewer-helpers';

/**
 * Everything the render action needs from the viewer component.
 *
 * The plain properties are read live on every draw, so the component
 * supplies them as getters over its `$state`; the functions are the
 * viewer commands an overlay can invoke (creating an annotation from a
 * drag, following a link, opening the signature pad).
 */
export interface PageRenderContext {
  readonly pdfjsLib: PdfJs | null;
  readonly pdfViewerLib: PdfViewer | null;
  readonly pdfDoc: PdfDocument | null;
  readonly container: HTMLDivElement | null;
  readonly annotations: PdfAnnotation[];
  readonly outline: FlatOutlineItem[];
  readonly activeTool: PdfTool;
  readonly areaMode: boolean;
  readonly isTrashed: boolean;
  readonly inkColor: string;
  readonly zoom: number;
  readonly zoomMode: ZoomMode;
  readonly selectedAnnotationId: string | null;
  readonly savedSignatures: PdfSignatureSnapshot[];
  readonly searchMatchesByPage: Map<number, PdfSearchMatch[]>;
  readonly searchVersion: number;
  readonly activeSearchMatchId: string | null;
  readonly pageViewports: Map<number, PdfViewport>;
  readonly pageCancelHooks: Map<number, () => void>;
  readonly pdfFieldObjectsPromise: Promise<unknown> | null;
  createAnnotation: CreateAnnotation;
  deleteAnnotation(id: string): void;
  moveAnnotation(id: string, dx: number, dy: number): void;
  selectAnnotation(id: string | null): void;
  getActiveSignature(): PdfSignatureSnapshot | null;
  openSignaturePad(): void;
  openExternalUrl(url: string): Promise<void> | void;
  followLinkDest(dest: string | unknown[] | null | undefined): Promise<void>;
  /** Drop back to the select tool once a one-shot placement is done. */
  resetToolToSelect(): void;
}

type CreateAnnotation = (
  type: PdfAnnotationType,
  pageIndex: number,
  rect: PdfRect | PdfRect[],
  body?: string,
  extras?: Partial<Pick<PdfAnnotation, 'strokes' | 'signature'>>
) => string | null;

export function createPageRenderer(ctx: PageRenderContext) {
  return function renderPage(
    pageSurface: HTMLDivElement,
    params: RenderParams
  ) {
    let current = params;
    let cancelled = false;
    let drawGeneration = 0;
    let pageView: PdfPageView | null = null;
    let pendingPageView: PdfPageView | null = null;
    let activeLayer: HTMLDivElement | null = null;
    let pendingLayer: HTMLDivElement | null = null;
    let currentViewport: ReturnType<
      Awaited<ReturnType<PdfDocument['getPage']>>['getViewport']
    > | null = null;
    let renderedSize: PageSize | null = null;
    // Link annotations for this page (external URLs + internal jumps),
    // fetched once per draw and overlaid as clickable anchors.
    let currentLinks: PdfLink[] = [];
    // Tears down the text-mode click-to-select listeners installed by
    // renderAppAnnotations (they live on the page element, which
    // outlives each annotation layer).
    let textModeClickCleanup: (() => void) | null = null;
    // Register the in-flight-cancel hook so the renderObserver can pre-empt
    // this page's render the instant the page leaves the band — even if
    // the DOM teardown is still inside its 200 ms grace window. Three
    // things happen here, in order:
    //   1. cancelScheduledDraw — if the kickoff timer hasn't fired yet,
    //      kill it. This is what stops doc.getPage() pileups on PDF.js's
    //      single worker thread during fast scroll: a page that's in the
    //      band for less than DRAW_KICKOFF_DELAY_MS never queues a fetch.
    //   2. drawGeneration += 1 — any in-flight draw() awaiting at the
    //      checkpoints below will read the new generation and bail.
    //   3. pageView.cancelRendering — interrupts the pageView's own
    //      render task (only relevant once draw() got past getPage()).
    ctx.pageCancelHooks.set(current.pageNumber, () => {
      cancelScheduledDraw();
      drawGeneration += 1;
      pendingPageView?.cancelRendering();
      pageView?.cancelRendering();
    });
    const overlays = createPageOverlays(ctx, {
      pageSurface,
      get params() {
        return current;
      },
      get viewport() {
        return currentViewport;
      },
      get links() {
        return currentLinks;
      },
      get textModeClickCleanup() {
        return textModeClickCleanup;
      },
      set textModeClickCleanup(value) {
        textModeClickCleanup = value;
      }
    });
    const { renderAppAnnotations, renderLinkLayer, renderSearchLayer } =
      overlays;

    function destroyPageView(view: PdfPageView | null) {
      view?.cancelRendering();
      view?.destroy();
    }

    function createPageLayer(kind: 'active' | 'pending'): HTMLDivElement {
      const layer = document.createElement('div');
      layer.className = `pdf-page-buffer pdf-page-buffer-${kind}`;
      return layer;
    }

    function clearPendingPageView(
      layer = pendingLayer,
      view = pendingPageView
    ) {
      if (view && view === pendingPageView) {
        destroyPageView(view);
        pendingPageView = null;
      }
      if (layer && layer === pendingLayer) {
        layer.remove();
        pendingLayer = null;
      }
    }

    function teardownPageView() {
      clearPendingPageView();
      textModeClickCleanup?.();
      textModeClickCleanup = null;
      destroyPageView(pageView);
      pageView = null;
      activeLayer = null;
      currentViewport = null;
      renderedSize = null;
      ctx.pageViewports.delete(current.pageNumber);
      pageSurface.replaceChildren();
      pageSurface.classList.remove('pdf-page-previewing');
    }

    function clearPreviewScale() {
      const pageEl = pageSurface.querySelector<HTMLElement>('.page');
      if (!pageEl) return;
      pageEl.style.transform = '';
      pageEl.style.transformOrigin = '';
      for (const child of Array.from(pageEl.children) as HTMLElement[]) {
        child.style.transform = '';
        child.style.transformOrigin = '';
        child.style.width = '';
        child.style.height = '';
        child.style.right = '';
        child.style.bottom = '';
      }
      if (renderedSize) {
        pageEl.style.width = `${renderedSize.width}px`;
        pageEl.style.height = `${renderedSize.height}px`;
      }
      pageSurface.classList.remove('pdf-page-previewing');
    }

    function measurePageSize(pageEl: HTMLElement): PageSize | null {
      const width = pageEl.offsetWidth;
      const height = pageEl.offsetHeight;
      if (width > 0 && height > 0) return { width, height };
      const rect = pageEl.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return { width: rect.width, height: rect.height };
      }
      return null;
    }

    function applyPreviewScale(target: PageSize) {
      if (!renderedSize || target.width <= 0 || target.height <= 0) return;
      const pageEl = pageSurface.querySelector<HTMLElement>('.page');
      if (!pageEl) return;
      const source = renderedSize ?? measurePageSize(pageEl);
      if (!source) return;
      renderedSize = source;
      const scaleX = target.width / Math.max(1, renderedSize.width);
      const scaleY = target.height / Math.max(1, renderedSize.height);
      pageEl.style.width = `${target.width}px`;
      pageEl.style.height = `${target.height}px`;
      if (Math.abs(scaleX - 1) < 0.001 && Math.abs(scaleY - 1) < 0.001) {
        clearPreviewScale();
        return;
      }
      for (const child of Array.from(pageEl.children) as HTMLElement[]) {
        child.style.width = `${renderedSize.width}px`;
        child.style.height = `${renderedSize.height}px`;
        child.style.right = 'auto';
        child.style.bottom = 'auto';
        child.style.transformOrigin = '0 0';
        child.style.transform = `scale(${scaleX}, ${scaleY})`;
      }
      pageSurface.classList.add('pdf-page-previewing');
    }

    let drawKickoffTimer: ReturnType<typeof setTimeout> | null = null;
    function cancelScheduledDraw() {
      if (drawKickoffTimer) {
        clearTimeout(drawKickoffTimer);
        drawKickoffTimer = null;
      }
    }
    function scheduleDraw(delayMs = DRAW_KICKOFF_DELAY_MS) {
      cancelScheduledDraw();
      drawKickoffTimer = setTimeout(() => {
        drawKickoffTimer = null;
        void draw();
      }, delayMs);
    }

    async function draw() {
      const generation = ++drawGeneration;
      const request = { ...current };
      const doc = ctx.pdfDoc;
      const pdfjs = ctx.pdfjsLib;
      const pdfViewer = ctx.pdfViewerLib;
      const renderContainer = ctx.container;
      if (!doc || !pdfjs || !pdfViewer || !renderContainer) return;
      if (!request.shouldRender) {
        teardownPageView();
        return;
      }
      clearPendingPageView();

      const page = await doc.getPage(request.pageNumber);
      if (cancelled || generation !== drawGeneration) return;

      const baseViewport = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(
        280,
        renderContainer.clientWidth - PAGE_FIT_MARGIN * 2
      );
      const fitScale = clampZoom(availableWidth / baseViewport.width);
      const requestedScale =
        request.zoomMode === 'fit-width' ? fitScale : clampZoom(request.zoom);
      const viewerScale = requestedScale / PDF_TO_CSS_UNITS;
      const viewport = page.getViewport({ scale: requestedScale });

      if (cancelled || generation !== drawGeneration) return;
      const nextLayer = createPageLayer('pending');
      pendingLayer = nextLayer;
      pageSurface.append(nextLayer);

      const eventBus = new pdfViewer.EventBus();
      const nextPageView = new pdfViewer.PDFPageView({
        container: nextLayer,
        eventBus,
        id: request.pageNumber,
        scale: viewerScale,
        defaultViewport: viewport,
        layerProperties: {
          annotationStorage: doc.annotationStorage,
          downloadManager: null,
          enableScripting: false,
          fieldObjectsPromise: ctx.pdfFieldObjectsPromise,
          findController: null,
          hasJSActionsPromise: Promise.resolve(false),
          linkService: new pdfViewer.SimpleLinkService({ eventBus })
        },
        annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
        maxCanvasPixels: MAX_CANVAS_PIXELS,
        maxCanvasDim: MAX_CANVAS_DIM,
        // pdf.js's capCanvasAreaFactor defaults to 200%, which caps the canvas
        // to 3× the *screen* area regardless of maxCanvasPixels — that was the
        // real cause of the blur past ~230-330% zoom, and why the cutoff
        // varied per monitor (it scales with screen size, not the page).
        // Disable it and rely on the explicit pixel/dimension caps above, which
        // sit at the browser's safe limits.
        capCanvasAreaFactor: -1,
        // The detail-canvas fallback renders only the visible region at full
        // res, but it must be driven by updateVisibleArea() on every scroll —
        // something only pdf.js's own PDFViewer does, not this standalone
        // PDFPageView. Left enabled but undriven it renders the base canvas at
        // 1/4 scale past the cap; disable it so over-cap zoom degrades to a
        // plain CSS upscale instead.
        enableDetailCanvas: false,
        enableSelectionRendering: true
      });
      pendingPageView = nextPageView;
      nextPageView.setPdfPage(page);
      try {
        // Link annotations for the clickable overlay. Best-effort: a
        // failure here shouldn't stop the page from rendering.
        let nextLinks: PdfLink[] = [];
        try {
          const annots = await page.getAnnotations({ intent: 'display' });
          if (cancelled || generation !== drawGeneration) {
            clearPendingPageView(nextLayer, nextPageView);
            return;
          }
          nextLinks = annots
            .filter((a: { subtype?: string }) => a.subtype === 'Link')
            .map((a: { rect: number[]; url?: string; dest?: unknown }) => ({
              rect: a.rect,
              url: a.url,
              dest: a.dest as string | unknown[] | null | undefined
            }));
        } catch {
          nextLinks = [];
        }
        await nextPageView.draw();
        if (cancelled || generation !== drawGeneration) {
          clearPendingPageView(nextLayer, nextPageView);
          return;
        }
        const pageEl = nextLayer.querySelector<HTMLElement>('.page');
        const previousPageView = pageView;
        const previousLayer = activeLayer;
        nextLayer.classList.remove('pdf-page-buffer-pending');
        nextLayer.classList.add('pdf-page-buffer-active');
        previousLayer?.remove();
        destroyPageView(previousPageView);
        pageView = nextPageView;
        activeLayer = nextLayer;
        pendingPageView = null;
        pendingLayer = null;
        currentViewport = viewport;
        renderedSize = pageEl
          ? (measurePageSize(pageEl) ?? {
              width: viewport.width,
              height: viewport.height
            })
          : { width: viewport.width, height: viewport.height };
        currentLinks = nextLinks;
        // Expose only the committed viewport so selection/client-rect math
        // never points at an invisible staging layer.
        ctx.pageViewports.set(request.pageNumber, viewport);
        clearPreviewScale();
        renderAppAnnotations();
      } catch (err) {
        clearPendingPageView(nextLayer, nextPageView);
        if (
          (err as { name?: string })?.name !== 'RenderingCancelledException'
        ) {
          console.warn('[PdfNoteViewer] page render failed', err);
        }
      }
    }

    // Initial mount: respect shouldRender like any other transition.
    // shouldRender=false short-circuits inside draw() so no worker calls
    // happen for the 95+ off-screen pages mounted at PDF open.
    if (params.shouldRender) scheduleDraw();
    return {
      update(next: RenderParams) {
        const prev = current;
        current = next;
        // Page entered the render window — draw it. Page left the window
        // (or pageNumber/zoom changed) — let draw() decide whether to
        // teardown or redraw, based on the now-current shouldRender flag.
        const enteringRender = next.shouldRender && !prev.shouldRender;
        const leavingRender = !next.shouldRender && prev.shouldRender;
        const visualChange =
          next.pageNumber !== prev.pageNumber ||
          next.version !== prev.version ||
          next.zoom !== prev.zoom ||
          next.zoomMode !== prev.zoomMode ||
          next.width !== prev.width ||
          next.height !== prev.height ||
          // Bumped when an externally-cancelled render needs to restart
          // after the user scrolled back inside the band before grace.
          next.invalidation !== prev.invalidation;
        if (leavingRender) {
          // Tear down immediately — the now-irrelevant pageView is hogging
          // worker capacity that a visible page needs. No debounce here.
          cancelScheduledDraw();
          void draw();
        } else if (enteringRender) {
          if (visualChange && next.shouldRender) {
            applyPreviewScale({ width: next.width, height: next.height });
          }
          // Debounce. Fast scrolling fires enteringRender for many pages
          // in quick succession; each call to scheduleDraw clears the
          // previous timer, so a page that's been in the band for less
          // than DRAW_KICKOFF_DELAY_MS never calls doc.getPage(). That
          // keeps the worker queue uncontended for whichever page the
          // user actually settles on.
          scheduleDraw();
        } else if (visualChange) {
          if (next.shouldRender) {
            applyPreviewScale({ width: next.width, height: next.height });
            scheduleDraw(0);
          }
        } else if (next.shouldRender) {
          // Same page, same zoom, still rendered — only annotation state
          // changed. Skip the canvas redraw and just refresh overlays.
          renderAppAnnotations();
        }
      },
      destroy() {
        cancelled = true;
        drawGeneration += 1;
        cancelScheduledDraw();
        ctx.pageCancelHooks.delete(current.pageNumber);
        teardownPageView();
      }
    };
  };
}
