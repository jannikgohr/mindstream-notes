import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageOverlays, type PageOverlayHost } from './page-overlays';
import { createPageRenderer, type PageRenderContext } from './page-render';
import type { PdfViewport, RenderParams } from './viewer-helpers';

const windowListeners = vi.spyOn(window, 'addEventListener');
afterEach(() => {
  for (const [type, listener] of windowListeners.mock.calls) {
    if (type.startsWith('pointer')) window.removeEventListener(type, listener);
  }
  windowListeners.mockClear();
  document.body.replaceChildren();
});

function pointer(target: EventTarget, type: string, x = 10, y = 20, id = 1) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      pointerId: id,
      clientX: x,
      clientY: y
    })
  );
}

function setup(tool: RenderParams['activeTool'] = 'highlight') {
  const pageSurface = document.createElement('div');
  pageSurface.innerHTML = '<div class="page"></div>';
  document.body.append(pageSurface);
  const page = pageSurface.firstElementChild as HTMLElement;
  page.getBoundingClientRect = () => new DOMRect(0, 0, 300, 400);
  const params: RenderParams = {
    pageNumber: 1,
    version: 0,
    zoom: 1,
    zoomMode: 'fixed',
    width: 300,
    height: 400,
    annotationVersion: 0,
    activeTool: tool,
    areaMode: true,
    selectedAnnotationId: null,
    shouldRender: true,
    invalidation: 0,
    searchVersion: 0
  };
  const ctx: PageRenderContext = {
    pdfjsLib: null,
    pdfViewerLib: null,
    pdfDoc: null,
    container: null,
    annotations: [],
    outline: [],
    activeTool: tool,
    areaMode: true,
    isTrashed: false,
    inkColor: '#123456',
    zoom: 1,
    zoomMode: 'fixed',
    selectedAnnotationId: null,
    savedSignatures: [],
    searchMatchesByPage: new Map(),
    searchVersion: 0,
    activeSearchMatchId: null,
    pageViewports: new Map(),
    pageCancelHooks: new Map(),
    pdfFieldObjectsPromise: null,
    createAnnotation: vi.fn(() => 'created'),
    deleteAnnotation: vi.fn(),
    moveAnnotation: vi.fn(),
    selectAnnotation: vi.fn(),
    getActiveSignature: () => null,
    openSignaturePad: vi.fn(),
    openExternalUrl: vi.fn(),
    followLinkDest: vi.fn(),
    resetToolToSelect: vi.fn()
  };
  const viewport = {
    scale: 1,
    convertToPdfPoint: (x: number, y: number) => [x, y],
    convertToViewportPoint: (x: number, y: number) => [x, y]
  } as PdfViewport;
  const host: PageOverlayHost = {
    pageSurface,
    params,
    viewport,
    gesturesEnabled: true,
    textModeClickCleanup: null
  };
  const overlays = createPageOverlays(ctx, host);
  overlays.renderAppAnnotations();
  const layer = () =>
    page.querySelector<HTMLElement>('.pdf-app-annotation-layer')!;
  return { ctx, params, page, host, overlays, layer };
}

describe('PDF overlay gestures', () => {
  it('commits an area once with the original PDF rectangle', () => {
    const { ctx, layer } = setup();
    pointer(layer(), 'pointerdown');
    pointer(window, 'pointermove', 60, 80);
    pointer(window, 'pointerup', 60, 80);
    pointer(window, 'pointerup', 90, 100);
    expect(ctx.createAnnotation).toHaveBeenCalledOnce();
    expect(ctx.createAnnotation).toHaveBeenCalledWith(
      'highlight',
      0,
      { x: 10, y: 20, width: 50, height: 60 },
      undefined,
      {}
    );
    expect(layer().querySelector('.pdf-app-annotation-preview')).toBeNull();
  });

  it.each(['highlight', 'pen'] as const)(
    'does not commit a cancelled %s gesture',
    (tool) => {
      const { ctx, layer } = setup(tool);
      pointer(layer(), 'pointerdown');
      pointer(window, 'pointermove', 60, 80);
      pointer(window, 'pointercancel', 60, 80);
      expect(layer().querySelector('[class*="preview"]')).toBeNull();
      pointer(window, 'pointerup', 90, 100);
      expect(ctx.createAnnotation).not.toHaveBeenCalled();
    }
  );

  it('does not let a removed area layer commit using the replacement tool', () => {
    const { ctx, params, overlays, layer } = setup();
    pointer(layer(), 'pointerdown');
    params.activeTool = 'comment';
    overlays.renderAppAnnotations();
    pointer(window, 'pointerup', 60, 80);
    expect(ctx.createAnnotation).not.toHaveBeenCalled();
  });

  it('keeps pen sampling and completes only once', () => {
    const { ctx, layer } = setup('pen');
    pointer(layer(), 'pointerdown');
    pointer(window, 'pointermove', 10.5, 20.5);
    pointer(window, 'pointermove', 60, 80);
    pointer(window, 'pointerup', 70, 90);
    pointer(window, 'pointerup', 100, 110);
    expect(ctx.createAnnotation).toHaveBeenCalledOnce();
    expect(
      vi.mocked(ctx.createAnnotation).mock.calls[0][4]?.strokes?.[0]
    ).toMatchObject({
      points: [
        { x: 10, y: 20 },
        { x: 60, y: 80 },
        { x: 70, y: 90 }
      ],
      color: '#123456',
      width: 2.25
    });
    expect(layer().querySelector('.pdf-app-ink-preview')).toBeNull();
  });

  it.each([
    ['highlight', null],
    ['comment', { x: 10, y: -16, width: 96, height: 36 }],
    ['signature', { x: 10, y: -28, width: 180, height: 48 }]
  ] as const)('preserves the small-area behavior for %s', (tool, rect) => {
    const { ctx, layer } = setup(tool);
    const signature = { id: 'signature', width: 100, height: 50, strokes: [] };
    ctx.savedSignatures.push(signature);
    ctx.getActiveSignature = () => signature;
    pointer(layer(), 'pointerdown');
    pointer(window, 'pointerup', 11, 21);
    if (!rect) expect(ctx.createAnnotation).not.toHaveBeenCalled();
    else
      expect(ctx.createAnnotation).toHaveBeenCalledWith(
        tool,
        0,
        rect,
        undefined,
        tool === 'signature' ? { signature } : {}
      );
  });

  it('ignores other pointers without consuming completion or cancellation', () => {
    const { ctx, layer } = setup();
    pointer(layer(), 'pointerdown');
    pointer(window, 'pointermove', 120, 150, 2);
    pointer(window, 'pointercancel', 120, 150, 2);
    pointer(window, 'pointerup', 120, 150, 2);
    expect(ctx.createAnnotation).not.toHaveBeenCalled();
    expect(
      layer()
        .querySelector('.pdf-app-annotation-preview')
        ?.getAttribute('style')
    ).toBeNull();
    pointer(window, 'pointerup', 60, 80);
    expect(ctx.createAnnotation).toHaveBeenCalledOnce();
  });

  it('replaces a pending gesture and removes its preview', () => {
    const { ctx, layer } = setup();
    pointer(layer(), 'pointerdown');
    const oldPreview = layer().firstElementChild!;
    pointer(layer(), 'pointerdown', 30, 40, 2);
    expect(oldPreview.isConnected).toBe(false);
    expect(layer().children).toHaveLength(1);
    pointer(window, 'pointerup', 60, 80);
    expect(ctx.createAnnotation).not.toHaveBeenCalled();
    pointer(window, 'pointerup', 60, 80, 2);
    expect(ctx.createAnnotation).toHaveBeenCalledOnce();
  });

  it('allows a completed command to rerender and begin another gesture synchronously', () => {
    const { ctx, overlays, layer } = setup();
    vi.mocked(ctx.createAnnotation).mockImplementationOnce(() => {
      overlays.renderAppAnnotations();
      pointer(layer(), 'pointerdown', 30, 40, 2);
      return 'created';
    });
    pointer(layer(), 'pointerdown');
    pointer(window, 'pointerup', 60, 80);
    expect(layer().querySelector('.pdf-app-annotation-preview')).not.toBeNull();
    pointer(window, 'pointerup', 90, 100, 2);
    expect(ctx.createAnnotation).toHaveBeenCalledTimes(2);
  });

  it('cancels before an unavailable viewport can skip rerender', () => {
    const { ctx, host, overlays, layer } = setup();
    pointer(layer(), 'pointerdown');
    Object.defineProperty(host, 'viewport', { value: null });
    overlays.renderAppAnnotations();
    pointer(window, 'pointerup', 60, 80);
    expect(ctx.createAnnotation).not.toHaveBeenCalled();
  });

  it.each(['highlight', 'pen'] as const)(
    'does not start %s before page geometry is committed',
    (tool) => {
      const { ctx, host, layer } = setup(tool);
      Object.defineProperty(host, 'gesturesEnabled', { value: false });
      pointer(layer(), 'pointerdown');
      pointer(window, 'pointerup', 60, 80);
      expect(layer().children).toHaveLength(0);
      expect(ctx.createAnnotation).not.toHaveBeenCalled();
    }
  );

  it.each(['pointercancel', 'rerender', 'teardown'] as const)(
    'clears movement and capture on %s without committing',
    (reason) => {
      const { ctx, overlays, layer } = setup('select');
      ctx.annotations.push({
        id: 'ink',
        type: 'ink',
        pageIndex: 0,
        rects: [{ x: 10, y: 20, width: 30, height: 40 }],
        color: '#000',
        opacity: 1,
        authorId: 'author',
        createdAt: '',
        updatedAt: ''
      });
      overlays.renderAppAnnotations();
      const node = layer().querySelector<HTMLElement>(
        '[data-annotation-id="ink"]'
      )!;
      let captured = false;
      node.setPointerCapture = vi.fn(() => {
        captured = true;
      });
      node.hasPointerCapture = () => captured;
      node.releasePointerCapture = vi.fn(() => {
        captured = false;
      });
      pointer(node, 'pointerdown');
      pointer(node, 'pointermove', 60, 80);
      expect(node.classList.contains('pdf-app-annotation-moving')).toBe(true);
      if (reason === 'pointercancel') pointer(node, reason, 60, 80);
      else if (reason === 'rerender') overlays.renderAppAnnotations();
      else overlays.cancelGesture();
      expect(captured).toBe(false);
      expect(node.releasePointerCapture).toHaveBeenCalledOnce();
      expect(node.style.transform).toBe('');
      expect(node.classList.contains('pdf-app-annotation-moving')).toBe(false);
      pointer(node, 'pointerup', 60, 80);
      expect(ctx.moveAnnotation).not.toHaveBeenCalled();
      expect(ctx.selectAnnotation).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    'preserves annotation click versus drag, moving: %s',
    (moving) => {
      const { ctx, overlays, layer } = setup('select');
      ctx.annotations.push({
        id: 'ink',
        type: 'ink',
        pageIndex: 0,
        rects: [{ x: 10, y: 20, width: 30, height: 40 }],
        color: '#000',
        opacity: 1,
        authorId: 'author',
        createdAt: '',
        updatedAt: ''
      });
      overlays.renderAppAnnotations();
      const node = layer().querySelector<HTMLElement>(
        '[data-annotation-id="ink"]'
      )!;
      pointer(node, 'pointerdown');
      pointer(node, 'pointermove', moving ? 60 : 12, moving ? 80 : 20);
      pointer(node, 'pointerup', moving ? 60 : 12, moving ? 80 : 20);
      if (moving) {
        expect(ctx.moveAnnotation).toHaveBeenCalledWith('ink', 50, 60);
        expect(ctx.selectAnnotation).not.toHaveBeenCalled();
      } else {
        expect(ctx.selectAnnotation).toHaveBeenCalledWith('ink');
        expect(ctx.moveAnnotation).not.toHaveBeenCalled();
      }
      expect(node.style.transform).toBe('');
    }
  );
});

describe('PDF renderer gesture ownership', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function renderer() {
    const { ctx, params, host } = setup();
    host.pageSurface.replaceChildren();
    class PageView {
      constructor({ container }: { container: HTMLElement }) {
        const page = document.createElement('div');
        page.className = 'page';
        page.getBoundingClientRect = () => new DOMRect(0, 0, 300, 400);
        container.append(page);
      }
      setPdfPage() {}
      async draw() {}
      cancelRendering() {}
      destroy() {}
    }
    const context: PageRenderContext = {
      ...ctx,
      pdfjsLib: {
        AnnotationMode: { ENABLE_FORMS: 2 }
      } as unknown as PageRenderContext['pdfjsLib'],
      pdfViewerLib: {
        PDFPageView: PageView,
        EventBus: class {},
        SimpleLinkService: class {}
      } as unknown as PageRenderContext['pdfViewerLib'],
      pdfDoc: {
        getPage: async () => ({
          getViewport: () => ({ ...host.viewport, width: 300, height: 400 })
        })
      } as unknown as PageRenderContext['pdfDoc'],
      container: document.createElement('div')
    };
    const action = createPageRenderer(context)(host.pageSurface, params);
    await vi.runOnlyPendingTimersAsync();
    const layer = () =>
      host.pageSurface.querySelector<HTMLElement>('.pdf-app-annotation-layer')!;
    expect(layer()).not.toBeNull();
    return { action, ctx, params, host, layer };
  }

  it.each([
    { zoom: 2 },
    { pageNumber: 2 },
    { shouldRender: false },
    { activeTool: 'pen' as const },
    { areaMode: false }
  ])('cancels before publishing an invalidating update: %j', async (change) => {
    const { action, ctx, params, layer } = await renderer();
    pointer(layer(), 'pointerdown');
    const preview = layer().firstElementChild!;
    action.update({ ...params, ...change });
    expect(preview.isConnected).toBe(false);
    pointer(window, 'pointerup', 60, 80);
    expect(ctx.createAnnotation).not.toHaveBeenCalled();
    action.destroy();
  });

  it('cancels on render-window eviction and allows a new gesture afterward', async () => {
    const { action, ctx, params, layer } = await renderer();
    pointer(layer(), 'pointerdown');
    ctx.pageCancelHooks.get(1)!();
    pointer(window, 'pointerup', 60, 80);
    expect(ctx.createAnnotation).not.toHaveBeenCalled();
    action.update({ ...params, invalidation: 1 });
    await vi.runOnlyPendingTimersAsync();
    pointer(layer(), 'pointerdown');
    pointer(window, 'pointerup', 60, 80);
    expect(ctx.createAnnotation).toHaveBeenCalledOnce();
    action.destroy();
  });

  it('does not commit after renderer destruction', async () => {
    const { action, ctx, layer } = await renderer();
    pointer(layer(), 'pointerdown');
    action.destroy();
    pointer(window, 'pointerup', 60, 80);
    expect(ctx.createAnnotation).not.toHaveBeenCalled();
    expect(ctx.pageCancelHooks.size).toBe(0);
  });

  it('blocks new gestures until a same-size replacement page is committed', async () => {
    const { action, ctx, params, layer } = await renderer();
    const next = { ...params, pageNumber: 2 };
    action.update(next);
    action.update({ ...next, annotationVersion: 1 });
    pointer(layer(), 'pointerdown');
    pointer(window, 'pointerup', 60, 80);
    expect(ctx.createAnnotation).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    pointer(layer(), 'pointerdown');
    pointer(window, 'pointerup', 60, 80);
    expect(ctx.createAnnotation).toHaveBeenCalledWith(
      'highlight',
      1,
      { x: 10, y: 20, width: 50, height: 60 },
      undefined,
      {}
    );
    action.destroy();
  });
});
