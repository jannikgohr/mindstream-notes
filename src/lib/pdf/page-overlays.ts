/**
 * The three overlays drawn on top of a rendered PDF page.
 *
 * Each is a plain DOM layer rebuilt from scratch whenever its inputs
 * change — search hits, the PDF's own link annotations, and our
 * annotations (highlights, comments, ink, signatures) together with the
 * pointer handling that creates and edits them.
 *
 * They read the page's current draw state through a [`PageOverlayHost`]
 * rather than closing over it, so the render action can own that state
 * while the overlay code lives here.
 */

import { tUi } from '$lib/settings/i18n.svelte';
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
  PdfStrokePoint
} from '$lib/pdf/types';
import {
  ANNOTATION_CLICK_SLOP_PX,
  INK_WIDTH,
  annotationIdAtPoint,
  type PdfLink,
  type PdfViewport,
  type RenderParams
} from '$lib/pdf/viewer-helpers';
import type { PageRenderContext } from './page-render';
import {
  annotationAriaLabel,
  annotationTypeLabel,
  formatPdfUi
} from './annotation-labels';

/** The per-page draw state the overlays read. Owned by the render action. */
export interface PageOverlayHost {
  readonly pageSurface: HTMLDivElement;
  /** The params of the draw currently on screen. */
  readonly params: RenderParams;
  readonly viewport: PdfViewport | null;
  /** Link annotations fetched for this page by the last draw. */
  readonly links: PdfLink[];
  /**
   * Teardown for the text-mode click-to-select listeners. They live on
   * the page element, which outlives any single annotation layer, so the
   * host holds the handle rather than the layer.
   */
  textModeClickCleanup: (() => void) | null;
}

export function createPageOverlays(
  ctx: PageRenderContext,
  host: PageOverlayHost
) {
  // Search-hit overlay: translucent boxes over every match on this page,
  // with the active hit emphasised. Read imperatively from the parent's
  // per-page match map; the `searchVersion` param triggers the refresh.
  function renderSearchLayer() {
    const pageEl = host.pageSurface.querySelector<HTMLElement>('.page');
    const viewport = host.viewport;
    if (!pageEl || !viewport) return;
    pageEl.querySelector('.pdf-search-layer')?.remove();
    const matches = ctx.searchMatchesByPage.get(host.params.pageNumber - 1);
    if (!matches || matches.length === 0) return;
    const layer = document.createElement('div');
    layer.className = 'pdf-search-layer';
    for (const match of matches) {
      for (const rect of match.rects) {
        const [x1, y1] = viewport.convertToViewportPoint(rect.x, rect.y);
        const [x2, y2] = viewport.convertToViewportPoint(
          rect.x + rect.width,
          rect.y + rect.height
        );
        const node = document.createElement('div');
        node.className = 'pdf-search-hit';
        if (match.id === ctx.activeSearchMatchId) {
          node.classList.add('pdf-search-hit-active');
        }
        node.dataset.searchMatchId = match.id;
        node.style.left = `${Math.min(x1, x2)}px`;
        node.style.top = `${Math.min(y1, y2)}px`;
        node.style.width = `${Math.abs(x2 - x1)}px`;
        node.style.height = `${Math.abs(y2 - y1)}px`;
        layer.append(node);
      }
    }
    pageEl.append(layer);
  }

  // Clickable overlay for the page's link annotations. Sits below the
  // app-annotation layer, so links are only hit in select mode (when
  // that layer passes pointer events through).
  function renderLinkLayer() {
    const pageEl = host.pageSurface.querySelector<HTMLElement>('.page');
    const viewport = host.viewport;
    if (!pageEl || !viewport) return;
    pageEl.querySelector('.pdf-link-layer')?.remove();
    if (host.links.length === 0) return;
    const layer = document.createElement('div');
    layer.className = 'pdf-link-layer';
    for (const link of host.links) {
      if (!Array.isArray(link.rect) || link.rect.length < 4) continue;
      const [x1, y1] = viewport.convertToViewportPoint(
        link.rect[0],
        link.rect[1]
      );
      const [x2, y2] = viewport.convertToViewportPoint(
        link.rect[2],
        link.rect[3]
      );
      const node = document.createElement(link.url ? 'a' : 'button');
      node.className = 'pdf-link';
      node.style.left = `${Math.min(x1, x2)}px`;
      node.style.top = `${Math.min(y1, y2)}px`;
      node.style.width = `${Math.abs(x2 - x1)}px`;
      node.style.height = `${Math.abs(y2 - y1)}px`;
      if (link.url) {
        const anchor = node as HTMLAnchorElement;
        anchor.href = link.url;
        anchor.title = link.url;
        anchor.rel = 'noopener noreferrer';
        anchor.addEventListener('click', (event) => {
          event.preventDefault();
          void ctx.openExternalUrl(link.url as string);
        });
      } else {
        node.addEventListener('click', (event) => {
          event.preventDefault();
          void ctx.followLinkDest(link.dest);
        });
      }
      layer.append(node);
    }
    pageEl.append(layer);
  }

  function activateAnnotation(annotation: PdfAnnotation) {
    if (host.params.activeTool === 'delete' && !ctx.isTrashed) {
      ctx.deleteAnnotation(annotation.id);
    } else {
      ctx.selectAnnotation(annotation.id);
    }
  }

  function renderAppAnnotations() {
    const pageEl = host.pageSurface.querySelector<HTMLElement>('.page');
    const viewport = host.viewport;
    if (!pageEl || !viewport) return;

    renderLinkLayer();
    renderSearchLayer();

    pageEl.querySelector('.pdf-app-annotation-layer')?.remove();
    const layer = document.createElement('div');
    layer.className = 'pdf-app-annotation-layer';
    // Text-aware modes (select, plus highlight/comment when NOT in area
    // mode) let pointer events fall through to the text layer so the
    // user can select words; everything else captures drags to draw.
    const textMode =
      host.params.activeTool === 'select' ||
      ((host.params.activeTool === 'highlight' ||
        host.params.activeTool === 'comment') &&
        !host.params.areaMode);
    layer.style.pointerEvents = textMode || ctx.isTrashed ? 'none' : 'auto';
    // In text mode the annotation nodes themselves are also
    // pointer-transparent — otherwise a highlight sitting on top of
    // the text layer would swallow the drag and make its own text
    // unselectable. Clicking an annotation still works: a plain click
    // (no drag, no resulting selection) is hit-tested against the
    // rendered rects below.
    const nodesInterceptPointer = !textMode;
    pageEl.append(layer);

    // Grab-and-drag an ink/signature node. A press that never travels past
    // the click slop just selects; a real drag translates the node live
    // (cheap CSS transform) and commits the PDF-space delta on release.
    function attachMoveHandler(node: HTMLElement, annotation: PdfAnnotation) {
      node.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const pageRect = pageEl!.getBoundingClientRect();
        const [pdfStartX, pdfStartY] = viewport!.convertToPdfPoint(
          event.clientX - pageRect.left,
          event.clientY - pageRect.top
        );
        const startClientX = event.clientX;
        const startClientY = event.clientY;
        let moving = false;
        node.setPointerCapture?.(event.pointerId);

        const onMove = (moveEvent: PointerEvent) => {
          const dxPx = moveEvent.clientX - startClientX;
          const dyPx = moveEvent.clientY - startClientY;
          if (!moving && Math.hypot(dxPx, dyPx) <= ANNOTATION_CLICK_SLOP_PX) {
            return;
          }
          moving = true;
          node.classList.add('pdf-app-annotation-moving');
          node.style.transform = `translate(${dxPx}px, ${dyPx}px)`;
        };
        const onUp = (upEvent: PointerEvent) => {
          node.removeEventListener('pointermove', onMove);
          node.removeEventListener('pointerup', onUp);
          node.releasePointerCapture?.(upEvent.pointerId);
          node.classList.remove('pdf-app-annotation-moving');
          node.style.transform = '';
          if (!moving) {
            ctx.selectAnnotation(annotation.id);
            return;
          }
          const [pdfEndX, pdfEndY] = viewport!.convertToPdfPoint(
            upEvent.clientX - pageRect.left,
            upEvent.clientY - pageRect.top
          );
          ctx.moveAnnotation(
            annotation.id,
            pdfEndX - pdfStartX,
            pdfEndY - pdfStartY
          );
        };
        node.addEventListener('pointermove', onMove);
        node.addEventListener('pointerup', onUp);
      });
    }

    const pageAnnotations = ctx.annotations.filter(
      (annotation) => annotation.pageIndex === host.params.pageNumber - 1
    );
    for (const annotation of pageAnnotations) {
      const rectCount = annotation.rects.length;
      for (const [rectIndex, rect] of annotation.rects.entries()) {
        const [x1, y1] = viewport.convertToViewportPoint(rect.x, rect.y);
        const [x2, y2] = viewport.convertToViewportPoint(
          rect.x + rect.width,
          rect.y + rect.height
        );
        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);
        const node = document.createElement('div');
        node.className = `pdf-app-annotation pdf-app-annotation-${annotation.type}`;
        if (annotation.id === host.params.selectedAnnotationId) {
          node.classList.add('pdf-app-annotation-selected');
        }
        if (annotation.resolved) {
          node.classList.add('pdf-app-annotation-resolved');
        }
        node.dataset.annotationId = annotation.id;
        node.tabIndex = 0;
        node.setAttribute('role', 'button');
        node.setAttribute(
          'aria-label',
          annotationAriaLabel(
            annotation,
            rectIndex,
            rectCount,
            host.params.selectedAnnotationId,
            host.params.activeTool
          )
        );
        node.setAttribute(
          'aria-pressed',
          annotation.id === host.params.selectedAnnotationId ? 'true' : 'false'
        );
        node.style.left = `${left}px`;
        node.style.top = `${top}px`;
        node.style.width = `${width}px`;
        node.style.height = `${height}px`;
        node.style.setProperty('--annotation-color', annotation.color);
        node.style.setProperty('--annotation-opacity', `${annotation.opacity}`);
        if (!nodesInterceptPointer) node.style.pointerEvents = 'none';
        node.title = annotation.body || node.getAttribute('aria-label') || '';
        if (annotation.type === 'signature' && annotation.signature) {
          const svg = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'svg'
          );
          svg.setAttribute(
            'viewBox',
            `0 0 ${annotation.signature.width} ${annotation.signature.height}`
          );
          svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
          svg.classList.add('pdf-app-stroke-svg');
          if (annotation.signature.image?.dataUrl) {
            const image = document.createElementNS(
              'http://www.w3.org/2000/svg',
              'image'
            );
            image.setAttribute('href', annotation.signature.image.dataUrl);
            image.setAttribute('x', '0');
            image.setAttribute('y', '0');
            image.setAttribute('width', `${annotation.signature.width}`);
            image.setAttribute('height', `${annotation.signature.height}`);
            image.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            svg.append(image);
          } else {
            for (const stroke of annotation.signature.strokes) {
              // Filled outline path (variable width via point pressure)
              // — same rendering as SignatureStrokes.svelte.
              const path = document.createElementNS(
                'http://www.w3.org/2000/svg',
                'path'
              );
              path.setAttribute('d', strokeOutlinePath(stroke));
              path.setAttribute('fill', stroke.color);
              path.setAttribute('stroke', 'none');
              svg.append(path);
            }
          }
          node.append(svg);
        } else if (annotation.type === 'ink' && annotation.strokes) {
          const svg = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'svg'
          );
          svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
          svg.classList.add('pdf-app-stroke-svg');
          for (const stroke of annotation.strokes) {
            const polyline = document.createElementNS(
              'http://www.w3.org/2000/svg',
              'polyline'
            );
            const points = stroke.points
              .map((point) => {
                const [pointX, pointY] = viewport.convertToViewportPoint(
                  point.x,
                  point.y
                );
                return `${pointX - left},${pointY - top}`;
              })
              .join(' ');
            polyline.setAttribute('points', points);
            polyline.setAttribute('fill', 'none');
            polyline.setAttribute('stroke', stroke.color);
            polyline.setAttribute(
              'stroke-width',
              `${stroke.width * viewport.scale}`
            );
            polyline.setAttribute('stroke-linecap', 'round');
            polyline.setAttribute('stroke-linejoin', 'round');
            svg.append(polyline);
          }
          node.append(svg);
        }
        // Ink and signatures float above the page, so in select mode the
        // user can grab and drag them to reposition. Highlights/comments
        // stay anchored to the text they mark and are not movable.
        const movable =
          !ctx.isTrashed &&
          (annotation.type === 'ink' || annotation.type === 'signature');
        if (textMode && movable) {
          node.style.pointerEvents = 'auto';
          node.classList.add('pdf-app-annotation-movable');
          attachMoveHandler(node, annotation);
        } else {
          node.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            event.stopPropagation();
            activateAnnotation(annotation);
          });
        }
        node.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          activateAnnotation(annotation);
        });
        layer.append(node);
      }
    }

    // Click-to-select for text mode: with the annotation nodes
    // pointer-transparent, discriminate click from drag on the page
    // itself. A press that travels less than the slop and leaves no
    // text selection behind selects the annotation under the pointer;
    // anything else is a selection drag and stays untouched.
    host.textModeClickCleanup?.();
    host.textModeClickCleanup = null;
    if (textMode && !ctx.isTrashed) {
      const controller = new AbortController();
      let downPoint: { x: number; y: number } | null = null;
      pageEl.addEventListener(
        'pointerdown',
        (event) => {
          downPoint =
            event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
        },
        { signal: controller.signal }
      );
      pageEl.addEventListener(
        'pointerup',
        (event) => {
          const start = downPoint;
          downPoint = null;
          if (!start) return;
          const travel = Math.hypot(
            event.clientX - start.x,
            event.clientY - start.y
          );
          if (travel > ANNOTATION_CLICK_SLOP_PX) return;
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed) return;
          const id = annotationIdAtPoint(layer, event.clientX, event.clientY);
          if (id) ctx.selectAnnotation(id);
        },
        { signal: controller.signal }
      );
      host.textModeClickCleanup = () => controller.abort();
    }

    if (host.params.activeTool === 'pen') {
      layer.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const pageRect = pageEl.getBoundingClientRect();
        const preview = document.createElementNS(
          'http://www.w3.org/2000/svg',
          'svg'
        );
        preview.setAttribute(
          'viewBox',
          `0 0 ${pageRect.width} ${pageRect.height}`
        );
        preview.classList.add('pdf-app-ink-preview');
        const previewStroke = document.createElementNS(
          'http://www.w3.org/2000/svg',
          'polyline'
        );
        previewStroke.setAttribute('fill', 'none');
        previewStroke.setAttribute('stroke', ctx.inkColor);
        previewStroke.setAttribute(
          'stroke-width',
          `${INK_WIDTH * viewport.scale}`
        );
        previewStroke.setAttribute('stroke-linecap', 'round');
        previewStroke.setAttribute('stroke-linejoin', 'round');
        preview.append(previewStroke);
        layer.append(preview);

        const pdfPoints: PdfStrokePoint[] = [];
        const viewportPoints: PdfStrokePoint[] = [];
        const pushPoint = (clientX: number, clientY: number) => {
          const x = clientX - pageRect.left;
          const y = clientY - pageRect.top;
          const previous = viewportPoints[viewportPoints.length - 1];
          if (previous && Math.hypot(x - previous.x, y - previous.y) < 1.5) {
            return;
          }
          const [pdfX, pdfY] = viewport.convertToPdfPoint(x, y);
          pdfPoints.push({ x: pdfX, y: pdfY });
          viewportPoints.push({ x, y });
          previewStroke.setAttribute(
            'points',
            strokePointsAttr(viewportPoints)
          );
        };

        pushPoint(event.clientX, event.clientY);

        const onMove = (moveEvent: PointerEvent) => {
          pushPoint(moveEvent.clientX, moveEvent.clientY);
        };
        const onUp = (upEvent: PointerEvent) => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          pushPoint(upEvent.clientX, upEvent.clientY);
          preview.remove();
          if (pdfPoints.length < 2) return;
          const rect = strokeBounds(pdfPoints, INK_WIDTH * 2);
          if (rect.width < 1 || rect.height < 1) return;
          ctx.createAnnotation(
            'ink',
            host.params.pageNumber - 1,
            rect,
            undefined,
            {
              strokes: [
                {
                  id: crypto.randomUUID(),
                  points: pdfPoints,
                  color: ctx.inkColor,
                  width: INK_WIDTH
                }
              ]
            }
          );
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
      });
      return;
    }

    // Drag-to-draw a rectangle is for signatures and for highlight/comment
    // only in area mode. In text mode highlight/comment come from the
    // selection (see the selection effect), so no drag handler here.
    const wantsAreaDraw =
      host.params.activeTool === 'signature' ||
      ((host.params.activeTool === 'highlight' ||
        host.params.activeTool === 'comment') &&
        host.params.areaMode);
    if (!wantsAreaDraw) {
      return;
    }

    layer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      if (
        host.params.activeTool === 'signature' &&
        ctx.savedSignatures.length === 0
      ) {
        ctx.openSignaturePad();
        ctx.resetToolToSelect();
        return;
      }
      const pageRect = pageEl.getBoundingClientRect();
      const startX = event.clientX - pageRect.left;
      const startY = event.clientY - pageRect.top;
      const [pdfStartX, pdfStartY] = viewport.convertToPdfPoint(startX, startY);
      const preview = document.createElement('div');
      preview.className = `pdf-app-annotation pdf-app-annotation-preview pdf-app-annotation-${host.params.activeTool}`;
      layer.append(preview);

      const updatePreview = (clientX: number, clientY: number) => {
        const x = clientX - pageRect.left;
        const y = clientY - pageRect.top;
        preview.style.left = `${Math.min(startX, x)}px`;
        preview.style.top = `${Math.min(startY, y)}px`;
        preview.style.width = `${Math.abs(x - startX)}px`;
        preview.style.height = `${Math.abs(y - startY)}px`;
      };

      const onMove = (moveEvent: PointerEvent) => {
        updatePreview(moveEvent.clientX, moveEvent.clientY);
      };
      const onUp = (upEvent: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        preview.remove();

        const endX = upEvent.clientX - pageRect.left;
        const endY = upEvent.clientY - pageRect.top;
        const [pdfEndX, pdfEndY] = viewport.convertToPdfPoint(endX, endY);
        let rect: PdfRect = {
          x: Math.min(pdfStartX, pdfEndX),
          y: Math.min(pdfStartY, pdfEndY),
          width: Math.abs(pdfEndX - pdfStartX),
          height: Math.abs(pdfEndY - pdfStartY)
        };

        if (
          host.params.activeTool === 'comment' &&
          (rect.width < 4 || rect.height < 4)
        ) {
          rect = {
            x: pdfStartX,
            y: pdfStartY - 36,
            width: 96,
            height: 36
          };
        }
        if (
          host.params.activeTool === 'signature' &&
          (rect.width < 4 || rect.height < 4)
        ) {
          rect = {
            x: pdfStartX,
            y: pdfStartY - 48,
            width: 180,
            height: 48
          };
        }
        if (rect.width < 4 || rect.height < 4) return;

        const annotationType: PdfAnnotationType =
          host.params.activeTool === 'comment'
            ? 'comment'
            : host.params.activeTool === 'signature'
              ? 'signature'
              : 'highlight';
        const activeSignature =
          annotationType === 'signature' ? ctx.getActiveSignature() : null;
        const signature =
          annotationType === 'signature' && activeSignature
            ? cloneSignatureSnapshot(activeSignature)
            : undefined;
        if (annotationType === 'signature' && !signature) return;
        // Comments are created empty; the sidebar editor opens focused
        // for the body (see commentDraftFocusId), replacing window.prompt.
        ctx.createAnnotation(
          annotationType,
          host.params.pageNumber - 1,
          rect,
          undefined,
          signature ? { signature } : {}
        );
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once: true });
    });
  }

  return { renderAppAnnotations, renderLinkLayer, renderSearchLayer };
}
