<script lang="ts">
  import { onMount } from 'svelte';
  import type { InkPage } from './page';
  import type { InkStroke } from './stroke-types';
  import { drawStroke } from './canvas-painter';
  import { cssColor } from './editor-helpers';

  let {
    page,
    revision,
    getBackground,
    strokesForPage,
    onVisibility
  }: {
    page: InkPage;
    revision: number;
    getBackground: (page: InkPage, scale: number) => HTMLCanvasElement | null;
    strokesForPage: (id: string) => InkStroke[];
    onVisibility: (page: InkPage, visible: boolean) => void;
  } = $props();
  let canvas: HTMLCanvasElement;
  let visible = $state(false);
  let paintedPage: InkPage | null = null;
  const scale = $derived(Math.min(108 / page.width, 144 / page.height));

  onMount(() => {
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  });

  $effect(() => {
    onVisibility(page, visible);
    return () => onVisibility(page, false);
  });

  $effect(() => {
    void revision;
    if (!visible || !canvas || paintedPage === page) return;
    const background = page.background ? getBackground(page, scale * 2) : null;
    if (page.background && !background) return;
    canvas.width = Math.max(1, Math.round(page.width * scale * 2));
    canvas.height = Math.max(1, Math.round(page.height * scale * 2));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (background)
      ctx.drawImage(background, 0, 0, canvas.width, canvas.height);
    const view = {
      width: canvas.width,
      height: canvas.height,
      scale: scale * 2,
      panX: 0,
      panY: 0
    };
    for (const stroke of strokesForPage(page.id))
      drawStroke(
        ctx,
        stroke.points,
        cssColor(stroke.color),
        stroke.width,
        view
      );
    paintedPage = page;
  });
</script>

<canvas
  bind:this={canvas}
  aria-hidden="true"
  class="pointer-events-none bg-white shadow-sm"
  style:width={`${page.width * scale}px`}
  style:height={`${page.height * scale}px`}
></canvas>
