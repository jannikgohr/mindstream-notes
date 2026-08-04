import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createViewerZoom, type ViewerZoomContext } from './viewer-zoom';
import { MAX_ZOOM, MIN_ZOOM, type ZoomMode } from './viewer-helpers';

/**
 * A stand-in for the component's `$state`. The controller only ever
 * reaches the viewer through this object, so a plain record with
 * accessors is a faithful substitute.
 */
function harness(container: HTMLDivElement | null = null) {
  const state = {
    zoom: 1,
    zoomMode: 'fixed' as ZoomMode,
    zoomMenuOpen: false,
    activePageNumber: 1,
    scrolledTo: [] as unknown[][]
  };
  const ctx: ViewerZoomContext = {
    get container() {
      return container;
    },
    get activePageNumber() {
      return state.activePageNumber;
    },
    get effectiveZoom() {
      return state.zoom;
    },
    get zoom() {
      return state.zoom;
    },
    set zoom(value) {
      state.zoom = value;
    },
    get zoomMode() {
      return state.zoomMode;
    },
    set zoomMode(value) {
      state.zoomMode = value;
    },
    get zoomMenuOpen() {
      return state.zoomMenuOpen;
    },
    set zoomMenuOpen(value) {
      state.zoomMenuOpen = value;
    },
    scrollToPage: (...args: unknown[]) => state.scrolledTo.push(args)
  };
  return { state, zoom: createViewerZoom(ctx) };
}

describe('zoom level', () => {
  it('setFixedZoom pins the mode, sets the level and closes the menu', () => {
    const { state, zoom } = harness();
    state.zoomMode = 'fit-width';
    state.zoomMenuOpen = true;

    zoom.setFixedZoom(2);

    expect(state.zoom).toBe(2);
    expect(state.zoomMode).toBe('fixed');
    expect(state.zoomMenuOpen).toBe(false);
  });

  it('clamps to the supported range in both directions', () => {
    const { state, zoom } = harness();

    zoom.setFixedZoom(999);
    expect(state.zoom).toBe(MAX_ZOOM);

    zoom.setFixedZoom(0.001);
    expect(state.zoom).toBe(MIN_ZOOM);
  });

  it('zoomBy multiplies the level currently in effect', () => {
    const { state, zoom } = harness();

    zoom.zoomBy(2);
    expect(state.zoom).toBe(2);

    zoom.zoomBy(0.5);
    expect(state.zoom).toBe(1);
  });

  it('zoomBy stops at the ceiling instead of overshooting', () => {
    const { state, zoom } = harness();
    zoom.setFixedZoom(MAX_ZOOM);

    zoom.zoomBy(2);

    expect(state.zoom).toBe(MAX_ZOOM);
  });

  it('setFitWidthZoom switches mode without touching the level', () => {
    const { state, zoom } = harness();
    zoom.setFixedZoom(3);

    zoom.setFitWidthZoom();

    expect(state.zoomMode).toBe('fit-width');
    // fit-width derives its own scale; the stored fixed level is untouched
    // so returning to fixed mode restores what the user last chose.
    expect(state.zoom).toBe(3);
  });

  it('toggleZoomMenu flips the menu open and shut', () => {
    const { state, zoom } = harness();

    zoom.toggleZoomMenu();
    expect(state.zoomMenuOpen).toBe(true);

    zoom.toggleZoomMenu();
    expect(state.zoomMenuOpen).toBe(false);
  });
});

describe('horizontal panning without a laid-out container', () => {
  it('reports no scroll target', () => {
    const { zoom } = harness();
    expect(zoom.targetScrollLeftForPage(1)).toBeNull();
  });

  it('re-centring and cancelling are safe no-ops', () => {
    const { zoom } = harness();
    expect(() => {
      zoom.recentreForLayoutChange(1);
      zoom.cancelPendingCentring();
    }).not.toThrow();
  });
});

describe('horizontal panning with a laid-out page', () => {
  let container: HTMLDivElement;

  function layOutPage({
    pageWidth,
    viewportWidth
  }: {
    pageWidth: number;
    viewportWidth: number;
  }) {
    container = document.createElement('div');
    const figure = document.createElement('figure');
    figure.dataset.pageNumber = '1';
    const host = document.createElement('div');
    host.className = 'pdf-page-host';
    figure.append(host);
    container.append(figure);
    document.body.append(container);

    // happy-dom doesn't lay out, so the geometry is stubbed directly.
    Object.defineProperty(host, 'offsetWidth', { value: pageWidth });
    Object.defineProperty(container, 'clientWidth', { value: viewportWidth });
    Object.defineProperty(container, 'scrollWidth', {
      value: Math.max(pageWidth, viewportWidth)
    });
    host.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: pageWidth, height: 10 }) as DOMRect;
    container.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: viewportWidth, height: 10 }) as DOMRect;
    return container;
  }

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('centres a page narrower than the viewport', () => {
    const el = layOutPage({ pageWidth: 400, viewportWidth: 1000 });
    const { zoom } = harness(el);

    // (400 / 2) - (1000 / 2) is negative, so it clamps to the left edge.
    expect(zoom.targetScrollLeftForPage(1)).toBe(0);
  });

  it('never scrolls past the end for a page wider than the viewport', () => {
    const el = layOutPage({ pageWidth: 2000, viewportWidth: 500 });
    const { zoom } = harness(el);

    const left = zoom.targetScrollLeftForPage(1);
    expect(left).not.toBeNull();
    expect(left!).toBeGreaterThanOrEqual(0);
    expect(left!).toBeLessThanOrEqual(2000 - 500);
  });

  it('returns null for a page that is not laid out', () => {
    const el = layOutPage({ pageWidth: 400, viewportWidth: 1000 });
    const { zoom } = harness(el);

    expect(zoom.targetScrollLeftForPage(7)).toBeNull();
  });
});

/**
 * A fully laid-out scroller: one figure/host with stubbed geometry, plus
 * writable scrollLeft/scrollTop (happy-dom clamps assignments to 0 without
 * layout, so they're redefined as plain accessors). Used to drive the
 * gesture handlers and the rAF-scheduled centring paths.
 */
function buildScroller({
  pageWidth,
  pageHeight = 1000,
  viewportWidth,
  viewportHeight = 400,
  pageLeft = 0
}: {
  pageWidth: number;
  pageHeight?: number;
  viewportWidth: number;
  viewportHeight?: number;
  pageLeft?: number;
}) {
  const container = document.createElement('div');
  const figure = document.createElement('figure');
  figure.dataset.pageNumber = '1';
  const host = document.createElement('div');
  host.className = 'pdf-page-host';
  figure.append(host);
  container.append(figure);
  document.body.append(container);

  const define = (el: HTMLElement, prop: string, value: number) =>
    Object.defineProperty(el, prop, { value, configurable: true });
  define(host, 'offsetWidth', pageWidth);
  define(host, 'offsetHeight', pageHeight);
  define(container, 'clientWidth', viewportWidth);
  define(container, 'clientHeight', viewportHeight);
  define(
    container,
    'scrollWidth',
    Math.max(pageWidth + pageLeft, viewportWidth)
  );
  define(container, 'scrollHeight', Math.max(pageHeight, viewportHeight));

  host.getBoundingClientRect = () =>
    ({
      left: pageLeft,
      top: 0,
      width: pageWidth,
      height: pageHeight,
      right: pageLeft + pageWidth,
      bottom: pageHeight
    }) as DOMRect;
  container.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: viewportWidth,
      height: viewportHeight,
      right: viewportWidth,
      bottom: viewportHeight
    }) as DOMRect;

  let scrollLeft = 0;
  let scrollTop = 0;
  Object.defineProperty(container, 'scrollLeft', {
    configurable: true,
    get: () => scrollLeft,
    set: (v: number) => {
      scrollLeft = v;
    }
  });
  Object.defineProperty(container, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    }
  });
  return { container, figure, host };
}

function dispatch(
  target: HTMLElement,
  type: string,
  props: Record<string, unknown>
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  let prevented = false;
  Object.assign(event, props, {
    preventDefault() {
      prevented = true;
    }
  });
  target.dispatchEvent(event);
  return () => prevented;
}

// Let both the microtask queue (svelte's `tick`) and the now-synchronous
// rAF drain, so the anchored-scroll body inside `zoomToAnchor` runs.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('gesture-driven zoom', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    // Run rAF callbacks synchronously so the anchored-scroll and centring
    // bodies execute within the test instead of on a real frame.
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback): number => {
        cb(0);
        return 1;
      }
    );
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('ctrl+wheel', () => {
    it('zooms in around the pointer and switches to fixed mode', async () => {
      const { container } = buildScroller({
        pageWidth: 800,
        viewportWidth: 500
      });
      const { state, zoom } = harness(container);
      document.elementFromPoint = () => null; // fall back to the active page
      const action = zoom.ctrlWheelZoom(container);

      const wasPrevented = dispatch(container, 'wheel', {
        ctrlKey: true,
        deltaY: -100,
        deltaX: 0,
        clientX: 250,
        clientY: 200
      });
      await flush();

      expect(wasPrevented()).toBe(true);
      expect(state.zoomMode).toBe('fixed');
      // exp(-(-100) * 0.001) ≈ 1.105, so the level ticks up from 1.
      expect(state.zoom).toBeGreaterThan(1);
      action.destroy();
    });

    it('anchors on the figure hit by elementFromPoint', async () => {
      const { container, host } = buildScroller({
        pageWidth: 800,
        viewportWidth: 500
      });
      const { state, zoom } = harness(container);
      document.elementFromPoint = () => host;
      const action = zoom.ctrlWheelZoom(container);

      dispatch(container, 'wheel', {
        ctrlKey: true,
        deltaY: -100,
        deltaX: 0,
        clientX: 250,
        clientY: 200
      });
      await flush();

      expect(state.zoom).toBeGreaterThan(1);
      // A wider-than-viewport page scrolls to keep the pointer anchored
      // rather than centring, so scrollLeft moves off zero.
      expect(container.scrollLeft).toBeGreaterThanOrEqual(0);
      action.destroy();
    });

    it('centres a narrower-than-viewport page when zooming around it', async () => {
      const { container, host } = buildScroller({
        pageWidth: 300,
        viewportWidth: 1000
      });
      const { state, zoom } = harness(container);
      document.elementFromPoint = () => host;
      const action = zoom.ctrlWheelZoom(container);

      dispatch(container, 'wheel', {
        ctrlKey: true,
        deltaY: -100,
        deltaX: 0,
        clientX: 500,
        clientY: 200
      });
      await flush();

      expect(state.zoom).toBeGreaterThan(1);
      // A page narrower than the viewport is centred (clamped to the left
      // edge here since 300/2 − 1000/2 is negative) rather than anchored.
      expect(container.scrollLeft).toBe(0);
      action.destroy();
    });

    it('shift+wheel pans horizontally by the combined delta', () => {
      const { container } = buildScroller({
        pageWidth: 800,
        viewportWidth: 500
      });
      const { zoom } = harness(container);
      const action = zoom.ctrlWheelZoom(container);

      const wasPrevented = dispatch(container, 'wheel', {
        shiftKey: true,
        deltaY: 50,
        deltaX: 10,
        clientX: 0,
        clientY: 0
      });

      expect(wasPrevented()).toBe(true);
      expect(container.scrollLeft).toBe(60);
      action.destroy();
    });

    it('plain wheel with a horizontal delta pans both axes', () => {
      const { container } = buildScroller({
        pageWidth: 800,
        pageHeight: 2000,
        viewportWidth: 500,
        viewportHeight: 400
      });
      const { zoom } = harness(container);
      const action = zoom.ctrlWheelZoom(container);

      const wasPrevented = dispatch(container, 'wheel', {
        deltaY: 30,
        deltaX: 20,
        clientX: 0,
        clientY: 0
      });

      expect(wasPrevented()).toBe(true);
      expect(container.scrollLeft).toBe(20);
      expect(container.scrollTop).toBe(30);
      action.destroy();
    });

    it('ignores a plain vertical wheel (native scroll handles it)', () => {
      const { container } = buildScroller({
        pageWidth: 800,
        viewportWidth: 500
      });
      const { zoom } = harness(container);
      const action = zoom.ctrlWheelZoom(container);

      const wasPrevented = dispatch(container, 'wheel', {
        deltaY: 40,
        deltaX: 0,
        clientX: 0,
        clientY: 0
      });

      expect(wasPrevented()).toBe(false);
      expect(container.scrollLeft).toBe(0);
      expect(container.scrollTop).toBe(0);
      action.destroy();
    });

    it('stops responding after the action is destroyed', async () => {
      const { container } = buildScroller({
        pageWidth: 800,
        viewportWidth: 500
      });
      const { state, zoom } = harness(container);
      document.elementFromPoint = () => null;
      const action = zoom.ctrlWheelZoom(container);
      action.destroy();

      dispatch(container, 'wheel', {
        ctrlKey: true,
        deltaY: -100,
        deltaX: 0,
        clientX: 250,
        clientY: 200
      });
      await flush();

      expect(state.zoom).toBe(1);
    });
  });

  describe('pinch zoom', () => {
    function pointer(
      target: HTMLElement,
      type: string,
      id: number,
      x: number,
      y: number,
      pointerType = 'touch'
    ) {
      return dispatch(target, type, {
        pointerId: id,
        pointerType,
        clientX: x,
        clientY: y
      });
    }

    it('scales by the ratio of finger spread and anchors the gesture', async () => {
      const { container } = buildScroller({
        pageWidth: 800,
        viewportWidth: 500
      });
      const { state, zoom } = harness(container);
      document.elementFromPoint = () => null;
      const action = zoom.touchPinchZoom(container);

      // Two fingers 100px apart, then spread to 200px → factor 2.
      pointer(container, 'pointerdown', 1, 100, 100);
      pointer(container, 'pointerdown', 2, 200, 100);
      const wasPrevented = pointer(container, 'pointermove', 2, 300, 100);
      await flush();

      expect(wasPrevented()).toBe(true);
      expect(state.zoom).toBeCloseTo(2, 5);

      pointer(container, 'pointerup', 1, 100, 100);
      pointer(container, 'pointerup', 2, 300, 100);
      action.destroy();
    });

    it('ignores non-touch pointers', async () => {
      const { container } = buildScroller({
        pageWidth: 800,
        viewportWidth: 500
      });
      const { state, zoom } = harness(container);
      const action = zoom.touchPinchZoom(container);

      pointer(container, 'pointerdown', 1, 100, 100, 'mouse');
      pointer(container, 'pointerdown', 2, 200, 100, 'mouse');
      pointer(container, 'pointermove', 2, 300, 100, 'mouse');
      await flush();

      expect(state.zoom).toBe(1);
      action.destroy();
    });

    it('does not zoom with a single finger down', async () => {
      const { container } = buildScroller({
        pageWidth: 800,
        viewportWidth: 500
      });
      const { state, zoom } = harness(container);
      const action = zoom.touchPinchZoom(container);

      pointer(container, 'pointerdown', 1, 100, 100);
      pointer(container, 'pointermove', 1, 150, 100);
      await flush();

      expect(state.zoom).toBe(1);
      action.destroy();
    });

    it('resets gesture state when a finger lifts', async () => {
      const { container } = buildScroller({
        pageWidth: 800,
        viewportWidth: 500
      });
      const { state, zoom } = harness(container);
      document.elementFromPoint = () => null;
      const action = zoom.touchPinchZoom(container);

      pointer(container, 'pointerdown', 1, 100, 100);
      pointer(container, 'pointerdown', 2, 200, 100);
      pointer(container, 'pointerup', 2, 200, 100);
      // Only one finger left: a further move must not keep zooming.
      const before = state.zoom;
      pointer(container, 'pointermove', 1, 400, 100);
      await flush();

      expect(state.zoom).toBe(before);
      action.destroy();
    });

    it('detaches all listeners on destroy', async () => {
      const { container } = buildScroller({
        pageWidth: 800,
        viewportWidth: 500
      });
      const { state, zoom } = harness(container);
      document.elementFromPoint = () => null;
      const action = zoom.touchPinchZoom(container);
      action.destroy();

      pointer(container, 'pointerdown', 1, 100, 100);
      pointer(container, 'pointerdown', 2, 200, 100);
      pointer(container, 'pointermove', 2, 300, 100);
      await flush();

      expect(state.zoom).toBe(1);
    });
  });

  describe('re-centring after layout changes', () => {
    it('centres the page in fit-width mode', () => {
      const { container } = buildScroller({
        pageWidth: 300,
        viewportWidth: 1000
      });
      const { state, zoom } = harness(container);
      state.zoomMode = 'fit-width';

      zoom.recentreForLayoutChange(1);

      expect(container.scrollLeft).toBe(zoom.targetScrollLeftForPage(1));
    });

    it('left-aligns a wide page with a margin on the first layout', () => {
      const { container } = buildScroller({
        pageWidth: 2000,
        viewportWidth: 500,
        pageLeft: 120
      });
      const { zoom } = harness(container);

      // Not fit-width, but the first centring pass always runs.
      zoom.recentreForLayoutChange(1);

      // pageLeft (120) − PAGE_FIT_MARGIN (16) = 104.
      expect(container.scrollLeft).toBe(104);
    });

    it('leaves a wide page alone once the initial centring has happened', () => {
      const { container } = buildScroller({
        pageWidth: 2000,
        viewportWidth: 500,
        pageLeft: 120
      });
      const { zoom } = harness(container);

      zoom.recentreForLayoutChange(1); // first pass sets scrollLeft to 104
      container.scrollLeft = 999; // user scrolled away
      zoom.recentreForLayoutChange(1); // wide page, fixed mode → left alone

      expect(container.scrollLeft).toBe(999);
    });

    it('setFitWidthZoom schedules a centring pass', () => {
      const { container } = buildScroller({
        pageWidth: 2000,
        viewportWidth: 500,
        pageLeft: 120
      });
      const { state, zoom } = harness(container);

      zoom.setFitWidthZoom();

      expect(state.zoomMode).toBe('fit-width');
      expect(container.scrollLeft).toBe(104);
    });
  });
});
