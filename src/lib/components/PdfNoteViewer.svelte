<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
  import {
    AlertCircle,
    Check,
    ChevronDown,
    FileText,
    Highlighter,
    Loader2,
    MessageSquare,
    Minus,
    MousePointer2,
    Plus,
    Trash2
  } from 'lucide-svelte';
  import * as Y from 'yjs';
  import { Button } from '$lib/components/ui/button';
  import { fetchDrawingAsset, loadNote, saveNote as apiSaveNote } from '$lib/api';
  import { listen } from '$lib/api/events';
  import { tree } from '$lib/stores/tree.svelte';
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
  type PdfTool = 'select' | 'highlight' | 'comment' | 'delete';
  type PdfAnnotationType = 'highlight' | 'comment';
  type PdfRect = {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  type PdfAnnotation = {
    id: string;
    type: PdfAnnotationType;
    pageIndex: number;
    rects: PdfRect[];
    color: string;
    opacity: number;
    authorId: string;
    createdAt: string;
    updatedAt: string;
    body?: string;
  };
  type RenderParams = {
    pageNumber: number;
    version: number;
    zoom: number;
    zoomMode: ZoomMode;
    annotationVersion: number;
    activeTool: PdfTool;
  };

  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 4;
  const ZOOM_STEP = 1.2;
  const QUICK_ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  const PDF_TO_CSS_UNITS = 96 / 72;
  const SAVE_DEBOUNCE_MS = 800;
  const PDF_ANNOTATIONS_MAP = 'pdf_annotations';
  const HIGHLIGHT_COLOR = '#facc15';
  const COMMENT_COLOR = '#3b82f6';

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
  let annotationVersion = $state(0);
  let annotations = $state<PdfAnnotation[]>([]);
  let activeTool = $state<PdfTool>('select');
  let savingState = $state<'idle' | 'pending' | 'saving' | 'saved' | 'error'>(
    'idle'
  );
  let isTrashed = $state(false);
  let pdfjsLib: PdfJs | null = null;
  let pdfViewerLib: PdfViewer | null = null;
  let yDoc: Y.Doc | null = null;
  let annotationsMap: Y.Map<PdfAnnotation> | null = null;
  let yDocUpdateHandler: (() => void) | null = null;
  let saveReady = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubSync: (() => void) | null = null;
  let resizeObserver: ResizeObserver | null = null;

  $effect(() => {
    setNoteStatus(noteId, {
      collabConfigured: false,
      collabOnline: false,
      savingState: error ? 'error' : loading ? 'idle' : savingState,
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

  function createAnnotation(
    type: PdfAnnotationType,
    pageIndex: number,
    rect: PdfRect,
    body?: string
  ) {
    if (!annotationsMap || isTrashed) return;
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    annotationsMap.set(id, {
      id,
      type,
      pageIndex,
      rects: [rect],
      color: type === 'highlight' ? HIGHLIGHT_COLOR : COMMENT_COLOR,
      opacity: type === 'highlight' ? 0.32 : 0.18,
      authorId: 'local',
      createdAt: now,
      updatedAt: now,
      body
    });
  }

  function deleteAnnotation(id: string) {
    if (isTrashed) return;
    annotationsMap?.delete(id);
  }

  function syncAnnotationsFromYDoc() {
    annotations = Array.from(annotationsMap?.values() ?? []).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    );
    annotationVersion += 1;
  }

  function scheduleSave() {
    if (isTrashed || !saveReady) return;
    savingState = 'pending';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void flushSave();
    }, SAVE_DEBOUNCE_MS);
  }

  async function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const doc = yDoc;
    if (!doc) return;
    try {
      savingState = 'saving';
      const yrsState = Array.from(Y.encodeStateAsUpdate(doc));
      await apiSaveNote({ id: noteId, yrs_state: yrsState });
      const existing = tree.notesById[noteId];
      if (existing) {
        tree.notesById[noteId] = {
          ...existing,
          modified: new Date().toISOString()
        };
      }
      savingState = 'saved';
    } catch (err) {
      savingState = 'error';
      console.error('[PdfNoteViewer] save failed', err);
    }
  }

  function setTool(tool: PdfTool) {
    activeTool = activeTool === tool && tool !== 'select' ? 'select' : tool;
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

      const localYDoc = new Y.Doc();
      yDoc = localYDoc;
      if (note.yrs_state.length > 0) {
        try {
          Y.applyUpdate(localYDoc, new Uint8Array(note.yrs_state));
        } catch (err) {
          console.warn('[PdfNoteViewer] yrs_state hydration failed', err);
        }
      }
      annotationsMap = localYDoc.getMap<PdfAnnotation>(PDF_ANNOTATIONS_MAP);
      syncAnnotationsFromYDoc();
      yDocUpdateHandler = () => {
        syncAnnotationsFromYDoc();
        scheduleSave();
      };
      localYDoc.on('update', yDocUpdateHandler);

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
      savingState = 'saved';
      saveReady = true;
      await tick();
      bumpRenderVersion();

      void listen('sync-completed', async (payload) => {
        if (!payload.notes_pulled_ids.includes(noteId) || !yDoc) return;
        try {
          const fresh = await loadNote(noteId);
          if (yDoc && fresh.yrs_state.length > 0) {
            Y.applyUpdate(yDoc, new Uint8Array(fresh.yrs_state));
          }
        } catch (err) {
          console.warn('[PdfNoteViewer] sync-completed merge failed', err);
        }
      }).then((unlisten) => {
        unsubSync = unlisten;
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      loading = false;
    }
  });

  onDestroy(() => {
    if (saveTimer) {
      void flushSave();
    }
    saveReady = false;
    unsubSync?.();
    unsubSync = null;
    resizeObserver?.disconnect();
    void pdfDoc?.cleanup();
    if (yDoc && yDocUpdateHandler) {
      yDoc.off('update', yDocUpdateHandler);
    }
    yDocUpdateHandler = null;
    yDoc?.destroy();
    yDoc = null;
    annotationsMap = null;
    clearNoteStatus(noteId);
  });

  function renderPage(pageSurface: HTMLDivElement, params: RenderParams) {
    let current = params;
    let cancelled = false;
    let drawGeneration = 0;
    let pageView: PdfPageView | null = null;
    let currentViewport:
      | ReturnType<Awaited<ReturnType<PdfDocument['getPage']>>['getViewport']>
      | null = null;

    function renderAppAnnotations() {
      const pageEl = pageSurface.querySelector<HTMLElement>('.page');
      const viewport = currentViewport;
      if (!pageEl || !viewport) return;

      pageEl.querySelector('.pdf-app-annotation-layer')?.remove();
      const layer = document.createElement('div');
      layer.className = 'pdf-app-annotation-layer';
      layer.style.pointerEvents =
        current.activeTool === 'select' || isTrashed ? 'none' : 'auto';
      pageEl.append(layer);

      const pageAnnotations = annotations.filter(
        (annotation) => annotation.pageIndex === current.pageNumber - 1
      );
      for (const annotation of pageAnnotations) {
        for (const rect of annotation.rects) {
          const [x1, y1] = viewport.convertToViewportPoint(rect.x, rect.y);
          const [x2, y2] = viewport.convertToViewportPoint(
            rect.x + rect.width,
            rect.y + rect.height
          );
          const node = document.createElement('div');
          node.className = `pdf-app-annotation pdf-app-annotation-${annotation.type}`;
          node.dataset.annotationId = annotation.id;
          node.style.left = `${Math.min(x1, x2)}px`;
          node.style.top = `${Math.min(y1, y2)}px`;
          node.style.width = `${Math.abs(x2 - x1)}px`;
          node.style.height = `${Math.abs(y2 - y1)}px`;
          node.style.setProperty('--annotation-color', annotation.color);
          node.style.setProperty('--annotation-opacity', `${annotation.opacity}`);
          if (annotation.body) node.title = annotation.body;
          if (current.activeTool === 'delete') {
            node.addEventListener('pointerdown', (event) => {
              event.preventDefault();
              event.stopPropagation();
              deleteAnnotation(annotation.id);
            });
          }
          layer.append(node);
        }
      }

      if (
        current.activeTool !== 'highlight' &&
        current.activeTool !== 'comment'
      ) {
        return;
      }

      layer.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const pageRect = pageEl.getBoundingClientRect();
        const startX = event.clientX - pageRect.left;
        const startY = event.clientY - pageRect.top;
        const [pdfStartX, pdfStartY] = viewport.convertToPdfPoint(
          startX,
          startY
        );
        const preview = document.createElement('div');
        preview.className = `pdf-app-annotation pdf-app-annotation-preview pdf-app-annotation-${current.activeTool}`;
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

          if (current.activeTool === 'comment' && (rect.width < 4 || rect.height < 4)) {
            rect = {
              x: pdfStartX,
              y: pdfStartY - 36,
              width: 96,
              height: 36
            };
          }
          if (rect.width < 4 || rect.height < 4) return;

          const annotationType: PdfAnnotationType =
            current.activeTool === 'comment' ? 'comment' : 'highlight';
          const body =
            annotationType === 'comment' ? window.prompt('Comment')?.trim() : undefined;
          createAnnotation(
            annotationType,
            current.pageNumber - 1,
            rect,
            body || undefined
          );
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
      });
    }

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
      currentViewport = viewport;

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
        if (cancelled || generation !== drawGeneration) return;
        renderAppAnnotations();
      } catch (err) {
        if ((err as { name?: string })?.name !== 'RenderingCancelledException') {
          console.warn('[PdfNoteViewer] page render failed', err);
        }
      }
    }

    void draw();
    return {
      update(next: RenderParams) {
        const shouldRedraw =
          next.pageNumber !== current.pageNumber ||
          next.version !== current.version ||
          next.zoom !== current.zoom ||
          next.zoomMode !== current.zoomMode;
        current = next;
        if (shouldRedraw) {
          void draw();
        } else {
          renderAppAnnotations();
        }
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
      class="shrink-0 border-b border-border bg-background"
      role="toolbar"
      aria-label="PDF controls"
    >
      <div class="flex h-9 items-center justify-between gap-2 pl-2">
        <div class="inline-flex items-center rounded-md border border-border bg-background p-0.5">
          <Button
            variant={activeTool === 'select' ? 'secondary' : 'ghost'}
            size="icon"
            class="size-7"
            onclick={() => setTool('select')}
            aria-label="Select"
            title="Select"
            aria-pressed={activeTool === 'select'}
          >
            <MousePointer2 class="size-3.5" aria-hidden="true" />
          </Button>

          <Button
            variant={activeTool === 'highlight' ? 'secondary' : 'ghost'}
            size="icon"
            class="size-7"
            onclick={() => setTool('highlight')}
            aria-label="Highlight"
            title="Highlight"
            aria-pressed={activeTool === 'highlight'}
            disabled={isTrashed}
          >
            <Highlighter class="size-3.5" aria-hidden="true" />
          </Button>

          <Button
            variant={activeTool === 'comment' ? 'secondary' : 'ghost'}
            size="icon"
            class="size-7"
            onclick={() => setTool('comment')}
            aria-label="Comment"
            title="Comment"
            aria-pressed={activeTool === 'comment'}
            disabled={isTrashed}
          >
            <MessageSquare class="size-3.5" aria-hidden="true" />
          </Button>

          <Button
            variant={activeTool === 'delete' ? 'secondary' : 'ghost'}
            size="icon"
            class="size-7"
            onclick={() => setTool('delete')}
            aria-label="Delete annotation"
            title="Delete annotation"
            aria-pressed={activeTool === 'delete'}
            disabled={isTrashed}
          >
            <Trash2 class="size-3.5" aria-hidden="true" />
          </Button>
        </div>

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
              use:renderPage={{
                pageNumber,
                version: renderVersion,
                zoom,
                zoomMode,
                annotationVersion,
                activeTool
              }}
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

  :global(.pdf-page-host .pdf-app-annotation-layer) {
    position: absolute;
    inset: 0;
    z-index: 3;
    overflow: clip;
    touch-action: none;
  }

  :global(.pdf-page-host .pdf-app-annotation) {
    position: absolute;
    box-sizing: border-box;
    border-radius: 2px;
  }

  :global(.pdf-page-host .pdf-app-annotation-highlight) {
    background: var(--annotation-color);
    opacity: var(--annotation-opacity);
  }

  :global(.pdf-page-host .pdf-app-annotation-comment) {
    border: 2px solid var(--annotation-color);
    background: color-mix(
      in srgb,
      var(--annotation-color) calc(var(--annotation-opacity) * 100%),
      transparent
    );
  }

  :global(.pdf-page-host .pdf-app-annotation-preview) {
    outline: 1px dashed color-mix(in srgb, var(--foreground) 70%, transparent);
    background: rgb(250 204 21 / 0.18);
  }
</style>
