/**
 * Zoom and horizontal panning for the PDF viewer.
 *
 * Two things live here because they are inseparable: choosing a zoom
 * level (fixed steps, fit-width, pinch, ctrl+wheel) and keeping the right
 * part of the page under the user's eye afterwards. Zooming around a
 * point means converting that point to a page-relative anchor before the
 * layout changes and scrolling back to it after — so the anchor maths and
 * the scroll maths cannot sensibly be separated.
 *
 * The gesture bookkeeping is private to the controller; only the values
 * the viewer renders (zoom, mode, menu state) live in the component and
 * are reached through [`ViewerZoomContext`].
 */

import { tick } from 'svelte';
import { PAGE_FIT_MARGIN } from '$lib/layout/page-layout';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  type ZoomAnchor,
  type ZoomMode
} from '$lib/pdf/viewer-helpers';

export interface ViewerZoomContext {
  readonly container: HTMLDivElement | null;
  /** The page the viewer currently considers active. */
  readonly activePageNumber: number;
  /** The zoom actually in effect, i.e. fit-width resolved to a number. */
  readonly effectiveZoom: number;
  zoom: number;
  zoomMode: ZoomMode;
  zoomMenuOpen: boolean;
  scrollToPage(
    pageNumber: number,
    behavior?: ScrollBehavior,
    options?: { force?: boolean }
  ): void;
}

export function createViewerZoom(ctx: ViewerZoomContext) {
  // Pinch-zoom gesture bookkeeping, and the token that lets a newer zoom
  // supersede an in-flight anchored scroll. All of it is private to this
  // controller.
  const touchZoomPointers = new Map<
    number,
    { clientX: number; clientY: number }
  >();
  let touchZoomAnchor: ZoomAnchor | null = null;
  let touchZoomDistance: number | null = null;
  let touchZoomStartZoom = 1;
  let touchZoomActive = false;
  let zoomScrollToken = 0;
  let horizontalCenterFrame = 0;
  let initialHorizontalCenterDone = false;

  function setFixedZoom(value: number) {
    ctx.zoomMode = 'fixed';
    ctx.zoom = clampZoom(value);
    ctx.zoomMenuOpen = false;
  }

  function setFitWidthZoom() {
    ctx.zoomMode = 'fit-width';
    ctx.zoomMenuOpen = false;
    scheduleHorizontalCenter();
  }

  function zoomBy(factor: number) {
    setFixedZoom(ctx.effectiveZoom * factor);
  }

  function toggleZoomMenu() {
    ctx.zoomMenuOpen = !ctx.zoomMenuOpen;
  }

  function pageHostForFigure(figure: HTMLElement): HTMLElement | null {
    return figure.querySelector<HTMLElement>('.pdf-page-host');
  }

  function figureForPage(pageNumber: number): HTMLElement | null {
    return (
      ctx.container?.querySelector<HTMLElement>(
        `figure[data-page-number="${pageNumber}"]`
      ) ?? null
    );
  }

  function clampScrollerPosition() {
    if (!ctx.container) return;
    const maxLeft = Math.max(
      0,
      ctx.container.scrollWidth - ctx.container.clientWidth
    );
    const maxTop = Math.max(
      0,
      ctx.container.scrollHeight - ctx.container.clientHeight
    );
    // Only write when actually out of range. Assigning scrollLeft/scrollTop —
    // even to their current value — aborts any in-flight smooth scroll (e.g.
    // the one started by scrollToPage), which is what broke page navigation.
    const clampedLeft = Math.min(
      maxLeft,
      Math.max(0, ctx.container.scrollLeft)
    );
    const clampedTop = Math.min(maxTop, Math.max(0, ctx.container.scrollTop));
    if (clampedLeft !== ctx.container.scrollLeft)
      ctx.container.scrollLeft = clampedLeft;
    if (clampedTop !== ctx.container.scrollTop)
      ctx.container.scrollTop = clampedTop;
  }

  function offsetInsideScroller(el: HTMLElement): {
    left: number;
    top: number;
  } {
    if (!ctx.container) return { left: 0, top: 0 };
    const scrollerRect = ctx.container.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left - scrollerRect.left + ctx.container.scrollLeft,
      top: rect.top - scrollerRect.top + ctx.container.scrollTop
    };
  }

  function pageFitsViewportWidth(pageHost: HTMLElement): boolean {
    if (!ctx.container) return false;
    return (
      pageHost.offsetWidth + PAGE_FIT_MARGIN * 2 <= ctx.container.clientWidth
    );
  }

  function centeredPageScrollLeft(
    pageHost: HTMLElement,
    pageOffset: { left: number }
  ): number {
    if (!ctx.container) return 0;
    return (
      pageOffset.left + pageHost.offsetWidth / 2 - ctx.container.clientWidth / 2
    );
  }

  // The scrollLeft that horizontally centers a page (or left-aligns it with a
  // small margin when it's wider than the viewport), clamped to range. Returns
  // null when the page isn't laid out yet.
  function targetScrollLeftForPage(pageNumber: number): number | null {
    if (!ctx.container) return null;
    const figure = figureForPage(pageNumber);
    const pageHost = figure ? pageHostForFigure(figure) : null;
    if (!pageHost) return null;
    const pageOffset = offsetInsideScroller(pageHost);
    const desired = pageFitsViewportWidth(pageHost)
      ? centeredPageScrollLeft(pageHost, pageOffset)
      : pageOffset.left - PAGE_FIT_MARGIN;
    const maxLeft = Math.max(
      0,
      ctx.container.scrollWidth - ctx.container.clientWidth
    );
    return Math.min(maxLeft, Math.max(0, desired));
  }

  function centerPageHorizontally(pageNumber = ctx.activePageNumber): boolean {
    if (!ctx.container) return false;
    const left = targetScrollLeftForPage(pageNumber);
    if (left == null) return false;
    ctx.container.scrollLeft = left;
    return true;
  }

  function scheduleHorizontalCenter(pageNumber = ctx.activePageNumber) {
    cancelAnimationFrame(horizontalCenterFrame);
    horizontalCenterFrame = requestAnimationFrame(() => {
      centerPageHorizontally(pageNumber);
    });
  }

  function zoomAnchorAtClientPoint(
    clientX: number,
    clientY: number
  ): ZoomAnchor | null {
    if (!ctx.container) return null;
    const hit = document.elementFromPoint(
      clientX,
      clientY
    ) as HTMLElement | null;
    const hitFigure = hit?.closest<HTMLElement>('figure[data-page-number]');
    const figure =
      hitFigure && ctx.container.contains(hitFigure)
        ? hitFigure
        : ctx.container.querySelector<HTMLElement>(
            `figure[data-page-number="${ctx.activePageNumber}"]`
          );
    if (!figure) return null;
    const pageNumber = Number(figure.dataset.pageNumber);
    const pageHost = pageHostForFigure(figure);
    if (!Number.isFinite(pageNumber) || !pageHost) return null;
    const rect = pageHost.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      pageNumber,
      xRatio: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      yRatio: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
    };
  }

  async function zoomToAnchor(
    nextZoom: number,
    anchor: ZoomAnchor | null,
    clientX: number,
    clientY: number
  ) {
    if (!ctx.container) return;
    const previous = ctx.effectiveZoom;
    const next = clampZoom(nextZoom);
    if (Math.abs(next - previous) < 0.001) return;
    const token = ++zoomScrollToken;

    ctx.zoomMode = 'fixed';
    ctx.zoom = next;
    await tick();
    requestAnimationFrame(() => {
      if (token !== zoomScrollToken) return;
      if (!ctx.container) return;
      if (!anchor) return;
      const figure = figureForPage(anchor.pageNumber);
      const pageHost = figure ? pageHostForFigure(figure) : null;
      if (!pageHost) return;
      const scrollerRect = ctx.container.getBoundingClientRect();
      const pageOffset = offsetInsideScroller(pageHost);
      const pointerX = clientX - scrollerRect.left;
      const pointerY = clientY - scrollerRect.top;
      ctx.container.scrollLeft = pageFitsViewportWidth(pageHost)
        ? centeredPageScrollLeft(pageHost, pageOffset)
        : pageOffset.left + anchor.xRatio * pageHost.offsetWidth - pointerX;
      ctx.container.scrollTop =
        pageOffset.top + anchor.yRatio * pageHost.offsetHeight - pointerY;
      clampScrollerPosition();
    });
  }

  async function zoomAroundClientPoint(
    nextZoom: number,
    clientX: number,
    clientY: number
  ) {
    await zoomToAnchor(
      nextZoom,
      zoomAnchorAtClientPoint(clientX, clientY),
      clientX,
      clientY
    );
  }

  async function zoomFromWheel(
    deltaY: number,
    clientX: number,
    clientY: number
  ) {
    await zoomAroundClientPoint(
      ctx.effectiveZoom * Math.exp(-deltaY * 0.001),
      clientX,
      clientY
    );
  }

  function touchDistance(): number | null {
    if (touchZoomPointers.size < 2) return null;
    const points = Array.from(touchZoomPointers.values()).slice(0, 2);
    return Math.hypot(
      points[0].clientX - points[1].clientX,
      points[0].clientY - points[1].clientY
    );
  }

  function touchCenter(): { clientX: number; clientY: number } | null {
    if (touchZoomPointers.size < 2) return null;
    const points = Array.from(touchZoomPointers.values()).slice(0, 2);
    return {
      clientX: (points[0].clientX + points[1].clientX) * 0.5,
      clientY: (points[0].clientY + points[1].clientY) * 0.5
    };
  }

  function touchPinchZoom(node: HTMLElement) {
    const captureOptions = { capture: true };
    const moveOptions = { capture: true, passive: false };
    const clearPointer = (id: number) => {
      touchZoomPointers.delete(id);
      if (touchZoomPointers.size < 2) {
        touchZoomAnchor = null;
        touchZoomDistance = null;
        touchZoomStartZoom = ctx.effectiveZoom;
        touchZoomActive = false;
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      touchZoomPointers.set(event.pointerId, {
        clientX: event.clientX,
        clientY: event.clientY
      });
      if (touchZoomPointers.size === 2) {
        const center = touchCenter();
        touchZoomDistance = touchDistance();
        touchZoomAnchor = center
          ? zoomAnchorAtClientPoint(center.clientX, center.clientY)
          : null;
        touchZoomStartZoom = ctx.effectiveZoom;
        touchZoomActive = true;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      if (!touchZoomPointers.has(event.pointerId)) return;
      touchZoomPointers.set(event.pointerId, {
        clientX: event.clientX,
        clientY: event.clientY
      });
      if (!touchZoomActive || touchZoomPointers.size < 2) return;
      const nextDistance = touchDistance();
      const center = touchCenter();
      if (!nextDistance || !touchZoomDistance || !center) return;
      event.preventDefault();
      const factor = nextDistance / touchZoomDistance;
      void zoomToAnchor(
        touchZoomStartZoom * factor,
        touchZoomAnchor,
        center.clientX,
        center.clientY
      );
    };

    const onPointerEnd = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      clearPointer(event.pointerId);
    };

    node.addEventListener('pointerdown', onPointerDown, captureOptions);
    node.addEventListener('pointermove', onPointerMove, moveOptions);
    node.addEventListener('pointerup', onPointerEnd, captureOptions);
    node.addEventListener('pointercancel', onPointerEnd, captureOptions);
    node.addEventListener('lostpointercapture', onPointerEnd, captureOptions);
    return {
      destroy() {
        node.removeEventListener('pointerdown', onPointerDown, captureOptions);
        node.removeEventListener('pointermove', onPointerMove, moveOptions);
        node.removeEventListener('pointerup', onPointerEnd, captureOptions);
        node.removeEventListener('pointercancel', onPointerEnd, captureOptions);
        node.removeEventListener(
          'lostpointercapture',
          onPointerEnd,
          captureOptions
        );
        touchZoomPointers.clear();
        touchZoomAnchor = null;
        touchZoomDistance = null;
        touchZoomStartZoom = ctx.effectiveZoom;
        touchZoomActive = false;
      }
    };
  }

  function ctrlWheelZoom(node: HTMLElement) {
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        void zoomFromWheel(e.deltaY, e.clientX, e.clientY);
        return;
      }
      if (e.shiftKey) {
        e.preventDefault();
        node.scrollLeft += e.deltaY + e.deltaX;
        clampScrollerPosition();
        return;
      }
      if (Math.abs(e.deltaX) > 0) {
        e.preventDefault();
        node.scrollLeft += e.deltaX;
        node.scrollTop += e.deltaY;
        clampScrollerPosition();
      }
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return {
      destroy() {
        node.removeEventListener('wheel', onWheel);
      }
    };
  }

  /**
   * Re-centre after a layout change (container resize, page count, zoom).
   *
   * The caller owns the reactive tracking and passes the page to centre
   * explicitly — reading it here would make a plain page change compete
   * with an in-flight smooth scroll from the toolbar.
   */
  function recentreForLayoutChange(pageNumber: number) {
    if (!ctx.container) return;
    cancelAnimationFrame(horizontalCenterFrame);
    horizontalCenterFrame = requestAnimationFrame(() => {
      const figure = figureForPage(pageNumber);
      const pageHost = figure ? pageHostForFigure(figure) : null;
      const shouldCenter =
        ctx.zoomMode === 'fit-width' ||
        !initialHorizontalCenterDone ||
        (pageHost ? pageFitsViewportWidth(pageHost) : false);
      if (shouldCenter && centerPageHorizontally(pageNumber)) {
        initialHorizontalCenterDone = true;
      }
    });
  }

  /** Drop any queued centring frame (component teardown). */
  function cancelPendingCentring() {
    cancelAnimationFrame(horizontalCenterFrame);
  }

  return {
    setFixedZoom,
    setFitWidthZoom,
    zoomBy,
    toggleZoomMenu,
    targetScrollLeftForPage,
    recentreForLayoutChange,
    cancelPendingCentring,
    touchPinchZoom,
    ctrlWheelZoom
  };
}
