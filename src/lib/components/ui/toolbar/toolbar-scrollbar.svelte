<script lang="ts">
  /**
   * A slim horizontal scrollbar rendered *below* a scrollable toolbar row.
   * The toolbar itself scrolls natively (overflow-x-auto) with its OS bar
   * hidden — a 12px native bar would eat a third of the dense 36px row — so
   * this mirrors the scroll position and lets the user drag to scroll.
   *
   * The thumb uses pointer events, so dragging works with both mouse and
   * touch; panning the toolbar content directly is handled natively. The
   * whole control is presentational (aria-hidden): keyboard focus already
   * scrolls the active control into view, and native scroll stays available.
   */
  import { onDestroy, onMount } from 'svelte';
  import { cn } from '$lib/utils';

  type Props = {
    /** The scrollable toolbar element (bind its `ref`). */
    target: HTMLElement | null;
    class?: string;
  };

  let { target, class: className }: Props = $props();

  let overflow = $state(false);
  let thumbWidthPct = $state(0);
  let thumbLeftPct = $state(0);
  let dragging = false;
  let dragStartX = 0;
  let dragStartScroll = 0;
  let resizeObserver: ResizeObserver | null = null;

  function update() {
    const el = target;
    if (!el) {
      overflow = false;
      return;
    }
    const max = el.scrollWidth - el.clientWidth;
    overflow = max > 1;
    if (!overflow) return;
    // Clamp the thumb to a grabbable minimum width.
    thumbWidthPct = Math.max((el.clientWidth / el.scrollWidth) * 100, 12);
    thumbLeftPct = (el.scrollLeft / max) * (100 - thumbWidthPct);
  }

  function observe() {
    resizeObserver?.disconnect();
    const el = target;
    if (!el) return;
    resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(el);
    // The row's width is stable while its content (collapsing groups, the
    // page count) changes, so observe the children to catch those reflows.
    for (const child of Array.from(el.children)) resizeObserver.observe(child);
    update();
  }

  $effect(() => {
    const el = target;
    observe();
    if (!el) return;
    const onScroll = () => update();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  });

  onMount(() => {
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    window.removeEventListener('resize', update);
    window.visualViewport?.removeEventListener('resize', update);
  });

  function onPointerDown(event: PointerEvent) {
    const el = target;
    if (!el) return;
    dragging = true;
    dragStartX = event.clientX;
    dragStartScroll = el.scrollLeft;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent) {
    if (!dragging) return;
    const el = target;
    if (!el) return;
    // Map thumb travel back to scroll distance by the track:content ratio.
    const delta = event.clientX - dragStartX;
    el.scrollLeft = dragStartScroll + delta * (el.scrollWidth / el.clientWidth);
  }

  function onPointerUp(event: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  }
</script>

{#if overflow}
  <div class={cn('px-1 py-0.5', className)} aria-hidden="true">
    <div class="relative h-1.5">
      <!-- Presentational: the parent is aria-hidden, so no label is needed. -->
      <!-- svelte-ignore a11y_consider_explicit_label -->
      <button
        type="button"
        tabindex="-1"
        class="absolute inset-y-0 touch-none rounded-full bg-foreground/20 transition-colors hover:bg-foreground/40"
        style="width: {thumbWidthPct}%; left: {thumbLeftPct}%;"
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
      ></button>
    </div>
  </div>
{/if}
