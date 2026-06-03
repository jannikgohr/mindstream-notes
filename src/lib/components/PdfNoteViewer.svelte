<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
  import {
    AlertCircle,
    Check,
    ChevronDown,
    FileText,
    Loader2,
    Minus,
    Plus
  } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import { fetchDrawingAsset, loadNote } from '$lib/api';
  import {
    clearNoteStatus,
    setNoteStatus
  } from '$lib/stores/note-status.svelte';

  interface Props {
    noteId: string;
  }
  let { noteId }: Props = $props();

  type PdfJs = typeof import('pdfjs-dist');
  type PdfViewer = typeof import('pdfjs-dist/web/pdf_viewer.mjs');
  type PdfDocument = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;
  type PdfPageView = InstanceType<PdfViewer['PDFPageView']>;
  type ZoomMode = 'fixed' | 'fit-width';
  type RenderParams = {
    pageNumber: number;
    version: number;
    zoom: number;
    zoomMode: ZoomMode;
  };

  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 4;
  const ZOOM_STEP = 1.2;
  const QUICK_ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  const PDF_TO_CSS_UNITS = 96 / 72;

  let container = $state<HTMLDivElement | null>(null);
  let zoomButton = $state<HTMLButtonElement | null>(null);
  let zoomMenuEl = $state<HTMLDivElement | null>(null);
  let pdfDoc = $state<PdfDocument | null>(null);
  let pageNumbers = $state<number[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let renderVersion = $state(0);
  let renderVersionCounter = 0;
  let zoom = $state(1);
  let zoomMode = $state<ZoomMode>('fixed');
  let firstPageWidth = $state(0);
  let zoomMenuOpen = $state(false);
  let menuRectVersion = $state(0);
  let isTrashed = $state(false);
  let pdfjsLib: PdfJs | null = null;
  let pdfViewerLib: PdfViewer | null = null;
  let resizeObserver: ResizeObserver | null = null;

  $effect(() => {
    setNoteStatus(noteId, {
      collabConfigured: false,
      collabOnline: false,
      savingState: error ? 'error' : loading ? 'idle' : 'saved',
      isTrashed
    });
  });

  function pdfAssetIdFromBody(body: string): string | null {
    const trimmed = body.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('asset_')) return trimmed;
    try {
      const parsed = JSON.parse(trimmed) as { pdfAssetId?: unknown };
      return typeof parsed.pdfAssetId === 'string' ? parsed.pdfAssetId : null;
    } catch {
      return null;
    }
  }

  function bumpRenderVersion() {
    renderVersionCounter += 1;
    renderVersion = renderVersionCounter;
  }

  function clampZoom(value: number): number {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  }

  const fitWidthZoom = $derived.by(() => {
    if (!container || firstPageWidth <= 0) return 1;
    return clampZoom((container.clientWidth - 32) / firstPageWidth);
  });

  const effectiveZoom = $derived(zoomMode === 'fit-width' ? fitWidthZoom : zoom);
  const zoomLabel = $derived(`${Math.round(effectiveZoom * 100)}%`);
  const menuRect = $derived.by(() => {
    void menuRectVersion;
    return zoomButton?.getBoundingClientRect() ?? null;
  });
  const menuLeft = $derived.by(() => {
    if (!menuRect || typeof window === 'undefined') return 0;
    const width = 160;
    return Math.max(8, Math.min(menuRect.left, window.innerWidth - width - 8));
  });
  const menuTop = $derived(menuRect ? menuRect.bottom : 0);

  function setFixedZoom(value: number) {
    zoomMode = 'fixed';
    zoom = clampZoom(value);
    zoomMenuOpen = false;
  }

  function setFitWidthZoom() {
    zoomMode = 'fit-width';
    zoomMenuOpen = false;
  }

  function zoomBy(factor: number) {
    setFixedZoom(effectiveZoom * factor);
  }

  function toggleZoomMenu() {
    zoomMenuOpen = !zoomMenuOpen;
    menuRectVersion += 1;
  }

  async function zoomFromWheel(deltaY: number, clientX: number, clientY: number) {
    if (!container) return;
    const previous = effectiveZoom;
    const next = clampZoom(previous * Math.exp(-deltaY * 0.001));
    if (Math.abs(next - previous) < 0.001) return;

    const rect = container.getBoundingClientRect();
    const offsetX = clientX - rect.left;
    const offsetY = clientY - rect.top;
    const xRatio = (container.scrollLeft + offsetX) / Math.max(1, container.scrollWidth);
    const yRatio = (container.scrollTop + offsetY) / Math.max(1, container.scrollHeight);

    zoomMode = 'fixed';
    zoom = next;
    await tick();
    requestAnimationFrame(() => {
      if (!container) return;
      container.scrollLeft = xRatio * container.scrollWidth - offsetX;
      container.scrollTop = yRatio * container.scrollHeight - offsetY;
    });
  }

  function ctrlWheelZoom(node: HTMLElement) {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      void zoomFromWheel(e.deltaY, e.clientX, e.clientY);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return {
      destroy() {
        node.removeEventListener('wheel', onWheel);
      }
    };
  }

  $effect(() => {
    if (!container) return;
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => {
      menuRectVersion += 1;
      bumpRenderVersion();
    });
    resizeObserver.observe(container);
  });

  $effect(() => {
    if (!zoomMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (zoomMenuEl?.contains(target)) return;
      if (zoomButton?.contains(target)) return;
      zoomMenuOpen = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') zoomMenuOpen = false;
    };
    const onResize = () => {
      menuRectVersion += 1;
    };
    queueMicrotask(() => window.addEventListener('pointerdown', onPointerDown));
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('scroll', onResize);

    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('scroll', onResize);
    };
  });

  $effect(() => {
    void zoom;
    void zoomMode;
    bumpRenderVersion();
  });

  onMount(async () => {
    try {
      const note = await loadNote(noteId);
      isTrashed = note.trashed;
      const assetId = pdfAssetIdFromBody(note.body);
      if (!assetId) throw new Error('PDF asset is missing.');

      const asset = await fetchDrawingAsset(assetId);
      if (asset.mime_type !== 'application/pdf') {
        throw new Error('Stored file is not a PDF.');
      }

      const pdfjs = await import('pdfjs-dist');
      const pdfViewer = await import('pdfjs-dist/web/pdf_viewer.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      pdfjsLib = pdfjs;
      pdfViewerLib = pdfViewer;
      const task = pdfjs.getDocument({ data: new Uint8Array(asset.bytes) });
      pdfDoc = await task.promise;
      const firstPage = await pdfDoc.getPage(1);
      firstPageWidth = firstPage.getViewport({ scale: 1 }).width;
      pageNumbers = Array.from({ length: pdfDoc.numPages }, (_, i) => i + 1);
      loading = false;
      await tick();
      bumpRenderVersion();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      loading = false;
    }
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    void pdfDoc?.cleanup();
    clearNoteStatus(noteId);
  });

  function renderPage(pageSurface: HTMLDivElement, params: RenderParams) {
    let current = params;
    let cancelled = false;
    let drawGeneration = 0;
    let pageView: PdfPageView | null = null;

    async function draw() {
      const generation = ++drawGeneration;
      const request = { ...current };
      const doc = pdfDoc;
      const pdfjs = pdfjsLib;
      const pdfViewer = pdfViewerLib;
      const renderContainer = container;
      if (!doc || !pdfjs || !pdfViewer || !renderContainer) return;
      pageView?.cancelRendering();
      pageView?.destroy();
      pageView = null;
      pageSurface.replaceChildren();

      const page = await doc.getPage(request.pageNumber);
      if (cancelled || generation !== drawGeneration) return;

      const baseViewport = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(280, renderContainer.clientWidth - 32);
      const fitScale = clampZoom(availableWidth / baseViewport.width);
      const requestedScale =
        request.zoomMode === 'fit-width' ? fitScale : clampZoom(request.zoom);
      const viewerScale = requestedScale / PDF_TO_CSS_UNITS;
      const viewport = page.getViewport({ scale: requestedScale });

      if (cancelled || generation !== drawGeneration) return;
      const eventBus = new pdfViewer.EventBus();
      pageView = new pdfViewer.PDFPageView({
        container: pageSurface,
        eventBus,
        id: request.pageNumber,
        scale: viewerScale,
        defaultViewport: viewport,
        annotationMode: pdfjs.AnnotationMode.DISABLE,
        maxCanvasPixels: -1,
        maxCanvasDim: -1,
        enableDetailCanvas: true,
        enableOptimizedPartialRendering: true,
        enableSelectionRendering: true
      });
      pageView.setPdfPage(page);
      try {
        await pageView.draw();
      } catch (err) {
        if ((err as { name?: string })?.name !== 'RenderingCancelledException') {
          console.warn('[PdfNoteViewer] page render failed', err);
        }
      }
    }

    void draw();
    return {
      update(next: RenderParams) {
        current = next;
        void draw();
      },
      destroy() {
        cancelled = true;
        drawGeneration += 1;
        pageView?.cancelRendering();
        pageView?.destroy();
      }
    };
  }
</script>

<div class="flex h-full w-full flex-col bg-background">
  {#if loading}
    <div class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 class="size-4 animate-spin" aria-hidden="true" />
      <span>Loading PDF…</span>
    </div>
  {:else if error}
    <div class="flex h-full items-center justify-center gap-2 p-6 text-sm text-destructive">
      <AlertCircle class="size-4 shrink-0" aria-hidden="true" />
      <span>{error}</span>
    </div>
  {:else}
    <div
      class="flex h-9 shrink-0 items-center justify-end gap-1 border-b border-border bg-background px-2"
      role="toolbar"
      aria-label="PDF controls"
    >
      <div class="inline-flex items-center rounded-md border border-border bg-background p-0.5">
        <Button
          variant="ghost"
          size="icon"
          class="size-7"
          onclick={() => zoomBy(1 / ZOOM_STEP)}
          aria-label="Zoom out"
          title="Zoom out"
        >
          <Minus class="size-3.5" aria-hidden="true" />
        </Button>

        <button
          bind:this={zoomButton}
          type="button"
          class="flex h-7 min-w-22 items-center justify-center gap-1 rounded-sm px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          onclick={toggleZoomMenu}
          aria-haspopup="menu"
          aria-expanded={zoomMenuOpen}
          title="Choose zoom"
        >
          <span>{zoomLabel}</span>
          <ChevronDown class="size-3" aria-hidden="true" />
        </button>

        <Button
          variant="ghost"
          size="icon"
          class="size-7"
          onclick={() => zoomBy(ZOOM_STEP)}
          aria-label="Zoom in"
          title="Zoom in"
        >
          <Plus class="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>

    <div
      bind:this={container}
      use:ctrlWheelZoom
      class="themed-scrollbar min-h-0 flex-1 overflow-auto px-3 py-4"
    >
      <div class="mx-auto flex min-w-full w-max flex-col items-center gap-4">
        {#each pageNumbers as pageNumber (pageNumber)}
          <figure class="flex w-max flex-col items-center gap-1">
            <div
              use:renderPage={{ pageNumber, version: renderVersion, zoom, zoomMode }}
              class="pdf-page-host pdfViewer bg-white shadow-sm ring-1 ring-border"
            ></div>
            <figcaption class="flex items-center gap-1 text-[10px] text-muted-foreground">
              <FileText class="size-3" aria-hidden="true" />
              Page {pageNumber}
            </figcaption>
          </figure>
        {/each}
      </div>
    </div>

    {#if zoomMenuOpen && menuRect}
      <div
        bind:this={zoomMenuEl}
        role="menu"
        class="fixed z-50 min-w-40 rounded-md border border-border bg-popover py-1 text-sm text-popover-foreground shadow-lg"
        style="left: {menuLeft}px; top: {menuTop}px;"
      >
        <button
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
          onclick={setFitWidthZoom}
        >
          <Check
            class="size-4 shrink-0 {zoomMode === 'fit-width' ? 'opacity-100' : 'opacity-0'}"
            aria-hidden="true"
          />
          <span>Fit width</span>
        </button>
        <div class="my-1 border-t border-border"></div>
        {#each QUICK_ZOOMS as option (option)}
          <button
            type="button"
            role="menuitem"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
            onclick={() => setFixedZoom(option)}
          >
            <Check
              class="size-4 shrink-0 {zoomMode === 'fixed' && Math.abs(zoom - option) < 0.01
                ? 'opacity-100'
                : 'opacity-0'}"
              aria-hidden="true"
            />
            <span>{Math.round(option * 100)}%</span>
          </button>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  :global(.pdf-page-host) {
    --scale-factor: 1;
    --page-bg-color: white;
    --page-border: 0;
    --page-margin: 0;
    --pdfViewer-padding-bottom: 0;
    --hcm-highlight-filter: none;
    --hcm-highlight-selected-filter: none;
    background-color: white;
  }

  :global(.pdf-page-host .page) {
    --user-unit: 1;
    --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
    --scale-round-x: 1px;
    --scale-round-y: 1px;
    direction: ltr;
    position: relative;
    overflow: visible;
    margin: 0;
    border: 0;
    background-clip: content-box;
    background-color: var(--page-bg-color);
  }

  :global(.pdf-page-host .canvasWrapper) {
    overflow: hidden;
    width: 100%;
    height: 100%;
  }

  :global(.pdf-page-host .canvasWrapper canvas) {
    position: absolute;
    top: 0;
    left: 0;
    display: block;
    width: 100%;
    height: 100%;
    margin: 0;
    contain: content;
  }

  :global(.pdf-page-host .textLayer) {
    color-scheme: only light;
    position: absolute;
    inset: 0;
    overflow: clip;
    line-height: 1;
    letter-spacing: normal;
    word-spacing: normal;
    text-align: initial;
    transform-origin: 0 0;
    -webkit-text-size-adjust: none;
    -moz-text-size-adjust: none;
    text-size-adjust: none;
    forced-color-adjust: none;
    caret-color: CanvasText;
    --min-font-size: 1;
    --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
    --min-font-size-inv: calc(1 / var(--min-font-size));
  }

  :global(.pdf-page-host .textLayer :is(span, br)) {
    color: transparent;
    position: absolute;
    white-space: pre;
    cursor: text;
    transform-origin: 0% 0%;
    -webkit-user-select: text;
    -moz-user-select: text;
    user-select: text;
  }

  :global(.pdf-page-host .textLayer > :not(.markedContent)),
  :global(.pdf-page-host .textLayer .markedContent span:not(.markedContent)) {
    z-index: 1;
    --font-height: 0;
    font-size: calc(var(--text-scale-factor) * var(--font-height));
    --scale-x: 1;
    --rotate: 0deg;
    transform: rotate(var(--rotate)) scaleX(var(--scale-x))
      scale(var(--min-font-size-inv));
  }

  :global(.pdf-page-host .textLayer .markedContent) {
    display: contents;
  }

  :global(.pdf-page-host .textLayer ::selection),
  :global(.pdf-page-host .textLayer br::selection) {
    background: transparent;
  }

  :global(.pdf-page-host .textLayer .endOfContent) {
    display: block;
    position: absolute;
    inset: 100% 0 0;
    z-index: 0;
    cursor: default;
    -webkit-user-select: none;
    -moz-user-select: none;
    user-select: none;
  }

  :global(.pdf-page-host .textLayer.selecting .endOfContent) {
    top: 0;
  }

  :global(.pdf-page-host .canvasWrapper .selection) {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    background: rgb(0 90 255 / 0.22);
  }
</style>
