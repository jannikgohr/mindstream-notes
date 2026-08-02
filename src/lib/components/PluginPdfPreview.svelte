<script lang="ts">
  /**
   * Lightweight, read-only PDF page renderer for plugin note previews. Takes raw
   * PDF bytes (e.g. a `typst` compile) and paints each page to a fit-width canvas
   * in a scrollable column — a deliberately minimal alternative to the full
   * PdfNoteViewer (which carries annotations, collab, history, …) that a live
   * preview doesn't need. Re-renders when `bytes` change; the new pages are built
   * off-DOM and swapped in at the end so a recompile doesn't flash empty.
   */
  import { onDestroy } from 'svelte';
  import { AlertTriangle, Loader2 } from '@lucide/svelte';
  import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

  type PdfJs = typeof import('pdfjs-dist');

  let pdfjsPromise: Promise<PdfJs> | null = null;
  function loadPdfJs(): Promise<PdfJs> {
    pdfjsPromise ??= import('pdfjs-dist').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      return pdfjs;
    });
    return pdfjsPromise;
  }

  interface Props {
    bytes: Uint8Array;
  }
  let { bytes }: Props = $props();

  // Horizontal breathing room around each page, and a hard cap on the render
  // scale so a huge page can't allocate an enormous canvas.
  const PAGE_MARGIN = 24;
  const MAX_SCALE = 2;

  let host = $state<HTMLDivElement | null>(null);
  let rendering = $state(false);
  let error = $state<string | null>(null);
  let token = 0;
  let destroyed = false;

  $effect(() => {
    const data = bytes;
    const el = host;
    if (!el || !data || data.length === 0) return;
    const myToken = ++token;
    void renderPdf(data, el, myToken);
  });

  async function renderPdf(
    data: Uint8Array,
    el: HTMLDivElement,
    myToken: number
  ) {
    rendering = true;
    error = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let doc: any = null;
    try {
      const pdfjs = await loadPdfJs();
      // pdf.js takes ownership of the buffer it's given; hand it a copy so the
      // caller's bytes (and any concurrent re-render) stay valid.
      doc = await pdfjs.getDocument({ data: data.slice() }).promise;
      if (stale(myToken)) return;

      const dpr = window.devicePixelRatio || 1;
      const targetWidth = Math.max(
        120,
        (el.clientWidth || 600) - PAGE_MARGIN * 2
      );
      const pages: HTMLElement[] = [];
      for (let i = 1; i <= doc.numPages; i += 1) {
        const page = await doc.getPage(i);
        if (stale(myToken)) return;
        const natural = page.getViewport({ scale: 1 });
        const scale = Math.min(MAX_SCALE, targetWidth / natural.width);
        const viewport = page.getViewport({ scale: scale * dpr });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.width = `${viewport.width / dpr}px`;
        canvas.style.height = `${viewport.height / dpr}px`;
        canvas.className =
          'block bg-white shadow-md rounded-sm max-w-full h-auto';
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not get a 2D canvas context.');
        await page.render({ canvasContext: ctx, viewport }).promise;
        if (stale(myToken)) return;
        pages.push(canvas);
      }
      if (stale(myToken)) return;
      // Swap all pages in atomically so the view never flashes blank.
      el.replaceChildren(...pages);
    } catch (err) {
      if (!stale(myToken)) {
        error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (doc && (destroyed || stale(myToken))) doc.destroy();
      else if (doc) queueDestroy(doc);
      if (!stale(myToken)) rendering = false;
    }
  }

  // Keep the document alive long enough to have rendered its pages, then free
  // it — the canvases hold the pixels, we don't need the parsed doc anymore.
  function queueDestroy(doc: { destroy: () => void }) {
    setTimeout(() => doc.destroy(), 0);
  }

  function stale(myToken: number): boolean {
    return destroyed || myToken !== token;
  }

  onDestroy(() => {
    destroyed = true;
    token += 1;
  });
</script>

<div class="relative flex min-h-0 flex-1 flex-col overflow-auto bg-muted/40">
  {#if error}
    <div
      class="absolute left-3 right-3 top-3 z-10 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
    >
      <AlertTriangle class="mt-0.5 size-3.5 shrink-0" />
      <span>{error}</span>
    </div>
  {/if}
  {#if rendering}
    <div class="absolute right-3 top-3 z-10">
      <Loader2 class="size-4 animate-spin text-muted-foreground" />
    </div>
  {/if}
  <div
    bind:this={host}
    class="flex min-h-0 flex-col items-center gap-4 p-6"
  ></div>
</div>
