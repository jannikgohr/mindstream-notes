import { beforeEach, describe, expect, it } from 'vitest';
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
