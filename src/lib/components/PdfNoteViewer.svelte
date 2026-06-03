<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
  import { AlertCircle, FileText, Loader2 } from 'lucide-svelte';
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
  type PdfDocument = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;
  type RenderParams = { pageNumber: number; version: number; zoom: number };

  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 4;

  let container = $state<HTMLDivElement | null>(null);
  let pdfDoc = $state<PdfDocument | null>(null);
  let pageNumbers = $state<number[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let renderVersion = $state(0);
  let zoom = $state(1);
  let isTrashed = $state(false);
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
    renderVersion += 1;
  }

  function clampZoom(value: number): number {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  }

  async function zoomFromWheel(deltaY: number, clientX: number, clientY: number) {
    if (!container) return;
    const previous = zoom;
    const next = clampZoom(previous * Math.exp(-deltaY * 0.001));
    if (Math.abs(next - previous) < 0.001) return;

    const rect = container.getBoundingClientRect();
    const offsetX = clientX - rect.left;
    const offsetY = clientY - rect.top;
    const xRatio = (container.scrollLeft + offsetX) / Math.max(1, container.scrollWidth);
    const yRatio = (container.scrollTop + offsetY) / Math.max(1, container.scrollHeight);

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
    resizeObserver = new ResizeObserver(() => bumpRenderVersion());
    resizeObserver.observe(container);
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
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      const task = pdfjs.getDocument({ data: new Uint8Array(asset.bytes) });
      pdfDoc = await task.promise;
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

  function renderPage(canvas: HTMLCanvasElement, params: RenderParams) {
    let current = params;
    let cancelled = false;
    let renderTask: { cancel?: () => void; promise: Promise<unknown> } | null = null;

    async function draw() {
      if (!pdfDoc || !container) return;
      renderTask?.cancel?.();
      const page = await pdfDoc.getPage(current.pageNumber);
      if (cancelled) return;

      const baseViewport = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(280, container.clientWidth - 32);
      const fitScale = Math.min(2, Math.max(1, availableWidth / baseViewport.width));
      const scale = clampZoom(fitScale * current.zoom);
      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const context = canvas.getContext('2d');
      if (!context) return;

      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0]
      });
      try {
        await renderTask.promise;
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
        renderTask?.cancel?.();
      }
    };
  }
</script>

<div class="flex h-full w-full flex-col bg-muted/30">
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
      bind:this={container}
      use:ctrlWheelZoom
      class="themed-scrollbar min-h-0 flex-1 overflow-auto px-3 py-4"
    >
      <div class="mx-auto flex min-w-full w-max flex-col items-center gap-4">
        {#each pageNumbers as pageNumber (pageNumber)}
          <figure class="flex w-max flex-col items-center gap-1">
            <canvas
              use:renderPage={{ pageNumber, version: renderVersion, zoom }}
              class="bg-white shadow-sm ring-1 ring-border"
            ></canvas>
            <figcaption class="flex items-center gap-1 text-[10px] text-muted-foreground">
              <FileText class="size-3" aria-hidden="true" />
              Page {pageNumber}
            </figcaption>
          </figure>
        {/each}
      </div>
    </div>
  {/if}
</div>
