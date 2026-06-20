<script lang="ts">
  /**
   * Left-hand navigation panel for the PDF viewer, with two tabs:
   *   - Thumbnails: a lazily-rendered rail of page previews. Each preview
   *     renders only once it scrolls near the rail viewport (its own
   *     IntersectionObserver), so opening the panel on a 500-page PDF
   *     doesn't render 500 canvases up front.
   *   - Outline: the document's bookmark tree, flattened with indentation.
   *
   * Presentation only: page jumps go out through `onJump`.
   */

  import { onDestroy } from 'svelte';
  import { X } from '@lucide/svelte';
  import { tooltip } from '$lib/actions/tooltip';
  import { Button } from '$lib/components/ui/button';
  import { tUi } from '$lib/settings/i18n.svelte';
  import type { FlatOutlineItem } from './outline';

  type PdfJs = typeof import('pdfjs-dist');
  type PdfDocument = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;
  type PageSize = { width: number; height: number };

  interface Props {
    pdfDoc: PdfDocument;
    pageCount: number;
    pageSizes: PageSize[];
    activePageNumber: number;
    outline: FlatOutlineItem[];
    onJump: (pageNumber: number) => void;
    onClose: () => void;
  }
  let {
    pdfDoc,
    pageCount,
    pageSizes,
    activePageNumber,
    outline,
    onJump,
    onClose
  }: Props = $props();

  const THUMB_WIDTH = 132;

  const hasOutline = $derived(outline.length > 0);
  let tab = $state<'thumbnails' | 'outline'>('thumbnails');

  let railEl = $state<HTMLDivElement | null>(null);
  // Pages whose thumbnail canvas has been (or is being) rendered.
  const renderedThumbs = new Set<number>();
  const thumbNodes = new Set<HTMLElement>();
  let thumbObserver: IntersectionObserver | null = null;

  const pageNumbers = $derived(
    Array.from({ length: pageCount }, (_, i) => i + 1)
  );

  function thumbAspect(pageNumber: number): number {
    const size = pageSizes[pageNumber - 1];
    if (!size || size.width <= 0) return 1.294; // letter-ish fallback
    return size.height / size.width;
  }

  async function renderThumb(node: HTMLElement, pageNumber: number) {
    if (renderedThumbs.has(pageNumber)) return;
    renderedThumbs.add(pageNumber);
    const canvas = node.querySelector('canvas');
    if (!canvas) {
      renderedThumbs.delete(pageNumber);
      return;
    }
    try {
      const page = await pdfDoc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = THUMB_WIDTH / base.width;
      const viewport = page.getViewport({ scale });
      const ratio =
        typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      canvas.width = Math.ceil(viewport.width * ratio);
      canvas.height = Math.ceil(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const scaled = page.getViewport({ scale: scale * ratio });
      await page.render({ canvas, viewport: scaled }).promise;
    } catch (err) {
      renderedThumbs.delete(pageNumber);
      console.warn('[PdfNavigator] thumbnail render failed', pageNumber, err);
    }
  }

  function thumb(node: HTMLElement, pageNumber: number) {
    node.dataset.thumbPage = String(pageNumber);
    thumbNodes.add(node);
    thumbObserver?.observe(node);
    return {
      destroy() {
        thumbNodes.delete(node);
        thumbObserver?.unobserve(node);
      }
    };
  }

  // (Re)create the observer once the rail mounts; observe any thumbnail
  // nodes whose actions already ran.
  $effect(() => {
    if (!railEl || tab !== 'thumbnails') return;
    const root = railEl;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const node = entry.target as HTMLElement;
          const pageNumber = Number(node.dataset.thumbPage);
          if (Number.isFinite(pageNumber)) void renderThumb(node, pageNumber);
        }
      },
      { root, rootMargin: '200% 0%' }
    );
    thumbObserver = observer;
    for (const node of thumbNodes) observer.observe(node);
    return () => {
      observer.disconnect();
      if (thumbObserver === observer) thumbObserver = null;
    };
  });

  // Keep the active page's thumbnail in view as the reader scrolls.
  $effect(() => {
    if (tab !== 'thumbnails' || !railEl) return;
    const active = railEl.querySelector<HTMLElement>(
      `[data-thumb-page="${activePageNumber}"]`
    );
    active?.scrollIntoView({ block: 'nearest' });
  });

  onDestroy(() => {
    thumbObserver?.disconnect();
    thumbObserver = null;
    thumbNodes.clear();
  });

  const goToLabel = (page: number) =>
    tUi('pdf.navigator.thumbnailLabel').replace('{page}', String(page));
</script>

<aside
  class="flex w-[min(15rem,80vw)] shrink-0 flex-col overflow-hidden border-r border-border bg-background"
  aria-label={tUi('pdf.navigator.label')}
>
  <div
    class="flex h-9 shrink-0 items-center justify-between gap-1 border-b border-border pl-1 pr-1"
  >
    <div class="flex items-center gap-0.5" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'thumbnails'}
        class="rounded px-2 py-1 text-xs font-medium transition-colors {tab ===
        'thumbnails'
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:bg-muted/60'}"
        onclick={() => (tab = 'thumbnails')}
      >
        {tUi('pdf.navigator.thumbnails')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'outline'}
        disabled={!hasOutline}
        class="rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-40 {tab ===
        'outline'
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:bg-muted/60'}"
        onclick={() => (tab = 'outline')}
      >
        {tUi('pdf.navigator.outline')}
      </button>
    </div>
    <Button
      variant="ghost"
      size="icon"
      class="size-7 text-muted-foreground"
      onclick={onClose}
      aria-label={tUi('pdf.navigator.close')}
      title={tUi('pdf.navigator.close')}
    >
      <X class="size-3.5" aria-hidden="true" />
    </Button>
  </div>

  {#if tab === 'thumbnails'}
    <div
      bind:this={railEl}
      class="themed-scrollbar flex min-h-0 flex-1 flex-col items-center gap-3 overflow-auto p-3"
    >
      {#each pageNumbers as pageNumber (pageNumber)}
        <button
          type="button"
          use:thumb={pageNumber}
          class="group flex flex-col items-center gap-1"
          aria-label={goToLabel(pageNumber)}
          aria-current={pageNumber === activePageNumber ? 'page' : undefined}
          onclick={() => onJump(pageNumber)}
        >
          <span
            class="block overflow-hidden rounded-sm bg-white ring-1 transition-[box-shadow,outline] {pageNumber ===
            activePageNumber
              ? 'outline outline-2 outline-ring ring-ring'
              : 'ring-border group-hover:ring-foreground/40'}"
            style="width:{THUMB_WIDTH}px; height:{Math.round(
              THUMB_WIDTH * thumbAspect(pageNumber)
            )}px"
          >
            <canvas class="block"></canvas>
          </span>
          <span
            class="text-[10px] tabular-nums {pageNumber === activePageNumber
              ? 'font-semibold text-foreground'
              : 'text-muted-foreground'}"
          >
            {pageNumber}
          </span>
        </button>
      {/each}
    </div>
  {:else}
    <nav
      class="themed-scrollbar flex min-h-0 flex-1 flex-col overflow-auto py-1"
      aria-label={tUi('pdf.navigator.outline')}
    >
      {#if !hasOutline}
        <p class="px-3 py-4 text-xs text-muted-foreground">
          {tUi('pdf.navigator.noOutline')}
        </p>
      {:else}
        {#each outline as entry (entry.id)}
          <button
            type="button"
            class="flex w-full items-center px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted/60 disabled:cursor-default disabled:opacity-50"
            style="padding-left:{0.75 + entry.depth * 0.75}rem"
            disabled={entry.pageIndex == null}
            onclick={() =>
              entry.pageIndex != null && onJump(entry.pageIndex + 1)}
            use:tooltip={entry.title}
          >
            <span class="truncate">{entry.title}</span>
          </button>
        {/each}
      {/if}
    </nav>
  {/if}
</aside>
